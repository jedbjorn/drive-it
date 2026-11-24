import builtins
import datetime
import importlib.abc
import io
import json
import math
import os
import stat as stat_module
import sys
import _thread

# The protocol is UTF-8 whatever the machine's locale. Pipes otherwise use the locale encoding
# (cp1252 on Windows), and -I makes Python ignore PYTHONIOENCODING.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")

_protocol_in = sys.stdin
_protocol_out = sys.stdout
_original_open = builtins.open
_original_io_open = io.open
_original_os_open = os.open
_original_stat = os.stat
_original_lstat = os.lstat
_original_access = os.access
_original_listdir = os.listdir
_original_makedirs = os.makedirs
_original_mkdir = os.mkdir
_original_remove = os.remove
_original_rename = os.rename
_original_replace = os.replace
_original_rmdir = os.rmdir
_original_scandir = os.scandir
_original_unlink = os.unlink
_request_id = 0
_checks = []
# Dev Mode (spec #10): set from Node's run message, which carries the mode Node's one resolver
# (server/mode.js) decided. A script cannot set it. In dev every worker guardrail is off.
_dev_mode = False
# A dry run (spec #13): set from Node's run message. Workspace file writes are skipped and reported to Node.
_dry_run = False

# Modules generated scripts may import; everything else is denied. Pure-Python
# modules are low risk to add. A native module must first be checked for file,
# process, or loader capabilities that bypass the audit hook (as sqlite3 and dbm do).
ALLOWED_MODULES = frozenset({
    "sys", "os", "os.path", "types", "io", "abc", "typing", "warnings", "traceback", "contextlib",
    "json", "csv", "re", "string", "textwrap", "difflib", "unicodedata", "pprint", "html",
    "math", "cmath", "statistics", "decimal", "fractions", "random", "numbers",
    "datetime", "time", "calendar",
    "collections", "collections.abc", "itertools", "functools", "operator", "heapq", "bisect",
    "array", "copy", "dataclasses", "enum", "struct",
    "base64", "binascii", "hashlib", "uuid",
    "pathlib", "fnmatch", "glob",
})


def _import_allowed(name):
    """An allowlisted module, or one of Python's own pure-Python text codecs, which load on first use (open(path, encoding="utf-16")).

    A script's import statement still names only ALLOWED_MODULES; a codec module is loaded by Python's codec lookup.
    """
    return name in ALLOWED_MODULES or name.startswith("encodings.")


IMPORT_DISABLED = "Package installation, process and thread execution, and native loading are disabled in the Drive It worker; only allowlisted modules can be imported."
SCRIPT_FILENAME = "<drive-it-script>"


PolicyPending = RuntimeError
PolicyDenied = PermissionError


class DryRunRefused(RuntimeError):
    """An operation with a lasting effect that a dry run cannot skip or roll back (spec #13)."""

    code = "not_allowed_in_dry_run"


class _SkippedText(io.StringIO):
    """What open() returns for a write a dry run skips: the script writes into it, and nothing reaches the disk."""


class _SkippedBinary(io.BytesIO):
    """The binary form of _SkippedText."""


class RevitError(Exception):
    def __init__(self, response):
        error = response.get("error") or {}
        super().__init__(error.get("message") or "Revit broker execution failed.")
        self.response = response


# --- The API bridge: script-side proxies for Revit objects the add-in holds (spec #15). ---
# A handle names an object in the add-in's per-run table; every use of it is one bridge call.
# Numbers, strings, booleans and None cross by value; lists convert to the collection a method takes.

_member_kinds = {}


def _bridge(call):
    response = _request("bridge.call", call)
    status = response.get("status")
    # An absolute path outside the workspace root waits for the operator, as a built-in operation does.
    if status == "pending":
        error = PolicyPending("Outside-root access is awaiting an operator decision.")
        error.detail = response
        raise error
    if status == "denied":
        error = PolicyDenied("Outside-root access was denied by the operator.")
        error.detail = response
        raise error
    if status != "succeeded":
        raise RevitError(response)
    return response.get("value")


def _encode(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, datetime.datetime):
        # A System.DateTime: an aware datetime crosses as the same instant in UTC; a naive one as local time, as Python reads it.
        if value.utcoffset() is not None:
            return {"$datetime": value.astimezone(datetime.timezone.utc).replace(tzinfo=None).isoformat(timespec="microseconds"), "utc": True}
        return {"$datetime": value.isoformat(timespec="microseconds"), "utc": False}
    if isinstance(value, _Handle):
        return {"$h": object.__getattribute__(value, "_h_id")}
    if isinstance(value, _Path):
        return {"$path": object.__getattribute__(value, "_p_path")}
    if isinstance(value, _Option):
        return dict(value.settings)
    if isinstance(value, _TypeName):
        if _dev_mode:
            # Dev Mode: no refusal. The type crosses as its DB path, which Revit takes wherever a type is taken.
            return {"$path": value.FullName}
        raise RevitError({"status": "failed", "error": {"code": "type_not_allowed", "message": (
            f"{value.FullName} from GetType() is text, not a handle: Drive-It gives a script no handle to a System.Type. "
            "Where Revit takes a type, pass the DB type, for example DB.Wall.")}})
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_encode(item) for item in value]
    raise TypeError(f"A {type(value).__name__} cannot cross to Revit; pass numbers, strings, booleans, None, datetimes, lists or Revit handles.")


def _decode(value):
    if isinstance(value, dict) and "$h" in value:
        return _Handle(value["$h"], value.get("type", ""))
    if isinstance(value, dict) and "$datetime" in value:
        # A System.DateTime: one Revit marked as UTC is an aware datetime in UTC, any other is naive.
        moment = datetime.datetime.fromisoformat(value["$datetime"])
        return moment.replace(tzinfo=datetime.timezone.utc) if value.get("utc") else moment
    if isinstance(value, dict) and "$tuple" in value:
        # A method with out parameters: its return value, then each out value.
        return tuple(_decode(item) for item in value["$tuple"])
    if isinstance(value, dict) and "$type" in value:
        return _TypeName(value["$type"])
    return value


class _TypeName:
    """What GetType() answers: a .NET type's Name, FullName and Namespace as text. Not a handle; it never reaches Revit."""

    __slots__ = ("Name", "FullName", "Namespace")

    def __init__(self, names):
        self.Name = names.get("Name")
        self.FullName = names.get("FullName")
        self.Namespace = names.get("Namespace")

    def __eq__(self, other):
        return isinstance(other, _TypeName) and self.FullName == other.FullName

    def __hash__(self):
        return hash(self.FullName)

    def __str__(self):
        return self.FullName

    def __repr__(self):
        return f"<type {self.FullName}>"


def _operator(name, *operands):
    """Arithmetic on Revit values runs Revit's own operator in the add-in; the worker does none of its own."""
    return _decode(_bridge({"op": "operator", "operator": name, "args": [_encode(operand) for operand in operands]}))


class _Option:
    """An object Revit calls back with a question, answered by Drive-It as configured here."""

    __slots__ = ("settings",)

    def __init__(self, kind, **settings):
        self.settings = {"$option": kind, **settings}

    def __repr__(self):
        return f"<revit.options.{self.settings['$option']}>"


class _Options:
    """revit.options: the helpers for Revit calls that ask a question back."""

    def family_load(self, overwrite=False, overwriteParameterValues=False):
        """For LoadFamily: replace a family that is already loaded (and its parameter values) only when asked."""
        if not isinstance(overwrite, bool) or not isinstance(overwriteParameterValues, bool):
            raise TypeError("revit.options.family_load takes overwrite and overwriteParameterValues as True or False.")
        return _Option("family_load", overwrite=overwrite, overwriteParameterValues=overwriteParameterValues)

    def copy_paste(self, duplicateTypes="abort"):
        """For CopyElements: when a type name exists in the destination, "abort" or "use_destination"."""
        if duplicateTypes not in ("abort", "use_destination"):
            raise ValueError('revit.options.copy_paste takes duplicateTypes="abort" or "use_destination".')
        return _Option("copy_paste", duplicateTypes=duplicateTypes)


def _arguments(args, kwargs):
    if kwargs:
        raise TypeError("Revit API calls take positional arguments only; pass them in the order the method lists them.")
    return [_encode(arg) for arg in args]


class _Member:
    """A method of a Revit object or DB type, called through the bridge."""

    __slots__ = ("_m_target", "_m_name")

    def __init__(self, target, name):
        object.__setattr__(self, "_m_target", target)
        object.__setattr__(self, "_m_name", name)

    def __call__(self, *args, **kwargs):
        target = object.__getattribute__(self, "_m_target")
        name = object.__getattribute__(self, "_m_name")
        return _decode(_bridge({"op": "call", "target": target, "member": name, "args": _arguments(args, kwargs)}))

    def __repr__(self):
        return f"<Revit method {object.__getattribute__(self, '_m_name')}>"


class _Proxy:
    __slots__ = ()

    def _target(self):
        raise NotImplementedError

    def __setattr__(self, name, value):
        _bridge({"op": "set", "target": self._target(), "member": name, "value": _encode(value)})

    def __getitem__(self, key):
        return _decode(_bridge({"op": "index", "target": self._target(), "key": _encode(key)}))

    def __iter__(self):
        chunk = _bridge({"op": "iter", "target": self._target()})
        while True:
            for item in chunk["items"]:
                yield _decode(item)
            if chunk["done"]:
                return
            chunk = _bridge({"op": "next", "iterator": chunk["$iter"]})

    def __len__(self):
        try:
            return _bridge({"op": "len", "target": self._target()})
        except RevitError as error:
            # list() and friends ask for a length first and accept TypeError as "unknown".
            if (error.response.get("error") or {}).get("code") == "no_length":
                raise TypeError(str(error)) from None
            raise

    def __eq__(self, other):
        try:
            encoded = _encode(other)
        except (TypeError, RevitError):
            return False
        return _bridge({"op": "eq", "target": self._target(), "other": encoded})

    def __ne__(self, other):
        return not self.__eq__(other)

    def __str__(self):
        return _bridge({"op": "str", "target": self._target()})

    def __bool__(self):
        return True

    def __add__(self, other):
        return _operator("op_Addition", self, other)

    def __radd__(self, other):
        return _operator("op_Addition", other, self)

    def __sub__(self, other):
        return _operator("op_Subtraction", self, other)

    def __rsub__(self, other):
        return _operator("op_Subtraction", other, self)

    def __mul__(self, other):
        return _operator("op_Multiply", self, other)

    def __rmul__(self, other):
        return _operator("op_Multiply", other, self)

    def __truediv__(self, other):
        return _operator("op_Division", self, other)

    def __rtruediv__(self, other):
        return _operator("op_Division", other, self)

    def __neg__(self):
        return _operator("op_UnaryNegation", self)


class _Handle(_Proxy):
    """A Revit object held by the add-in for this run."""

    __slots__ = ("_h_id", "_h_type")

    def __init__(self, handle_id, type_name):
        object.__setattr__(self, "_h_id", handle_id)
        object.__setattr__(self, "_h_type", type_name)

    def _target(self):
        return {"$h": object.__getattribute__(self, "_h_id")}

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        type_name = object.__getattribute__(self, "_h_type")
        if _member_kinds.get((type_name, name)) == "method":
            return _Member(self._target(), name)
        value = _bridge({"op": "get", "target": self._target(), "member": name})
        if isinstance(value, dict) and "$method" in value:
            _member_kinds[(type_name, name)] = "method"
            return _Member(self._target(), name)
        return _decode(value)

    def __hash__(self):
        return hash(object.__getattribute__(self, "_h_type"))

    def __repr__(self):
        return f"<Revit {object.__getattribute__(self, '_h_type')} handle>"


class _Path(_Proxy):
    """A name under DB (a namespace, type, enum value or static member), resolved by the add-in when used."""

    __slots__ = ("_p_path",)

    def __init__(self, path):
        object.__setattr__(self, "_p_path", path)

    def _target(self):
        return {"$path": object.__getattribute__(self, "_p_path")}

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Path(f"{object.__getattribute__(self, '_p_path')}.{name}")

    def __call__(self, *args, **kwargs):
        return _decode(_bridge({"op": "call", "target": self._target(), "args": _arguments(args, kwargs)}))

    def __hash__(self):
        return hash(object.__getattribute__(self, "_p_path"))

    def __repr__(self):
        return f"<DB {object.__getattribute__(self, '_p_path')[len('Autodesk.Revit.'):]}>"


class _Transaction:
    """with revit.transaction("name"): commits on leaving the block, rolls back if it raises."""

    def __init__(self, revit, name, document):
        self._revit = revit
        self._name = str(name)
        self._document = document
        self._id = None

    def __enter__(self):
        self._id = _bridge({"op": "tx.start", "name": self._name, "document": self._revit._document_target(self._document)})
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is None:
            _bridge({"op": "tx.commit", "transaction": self._id})
            return False
        try:
            _bridge({"op": "tx.rollback", "transaction": self._id})
        except RevitError:
            pass
        return False


class RuntimeRestriction(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if not _import_allowed(fullname):
            raise ImportError(IMPORT_DISABLED)
        return None


def _request(method, params):
    global _request_id
    _request_id += 1
    _protocol_out.write(json.dumps({"type": "request", "id": _request_id, "method": method, "params": params}) + "\n")
    _protocol_out.flush()
    line = _protocol_in.readline()
    if not line:
        raise RuntimeError("Drive It disconnected from the Python worker.")
    response = json.loads(line)
    if response.get("error"):
        raise RuntimeError(response["error"].get("message", "Drive It request failed."))
    return response["result"]


def _create_file_policy(protocol_in, protocol_out, policy_pending, policy_denied, enforce=True, dry_run=False):
    original_open = builtins.open
    original_import = builtins.__import__
    original_os_open = os.open
    original_functions = {
        "stat": os.stat,
        "lstat": os.lstat,
        "access": os.access,
        "listdir": os.listdir,
        "makedirs": os.makedirs,
        "mkdir": os.mkdir,
        "remove": os.remove,
        "rename": os.rename,
        "replace": os.replace,
        "rmdir": os.rmdir,
        "scandir": os.scandir,
        "unlink": os.unlink,
    }
    dumps = json.dumps
    loads = json.loads
    getframe = sys._getframe
    abspath = os.path.abspath
    fspath = os.fspath
    fsdecode = os.fsdecode
    skipped_text = _SkippedText
    skipped_binary = _SkippedBinary
    refused = DryRunRefused
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
    is_instance = builtins.isinstance
    string_type = str
    bytes_type = bytes
    string_value = str.__str__
    bytes_value = bytes.__bytes__
    integer_and = int.__and__
    exception_setattr = BaseException.__setattr__
    trusted_filename = __file__
    request_id = 0
    call_stack = []

    def request(method, params):
        nonlocal request_id
        request_id += 1
        protocol_out.write(dumps({"type": "request", "id": request_id, "method": method, "params": params}) + "\n")
        protocol_out.flush()
        line = protocol_in.readline()
        if not line:
            raise RuntimeError("Drive It disconnected from the Python worker.")
        response = loads(line)
        if response.get("error"):
            raise RuntimeError(response["error"].get("message", "Drive It request failed."))
        return response["result"]

    def absolute_path(path):
        if is_instance(path, string_type):
            return abspath(string_value(path))
        if is_instance(path, bytes_type):
            return abspath(bytes_value(path))
        raise TypeError("File paths must resolve to text or bytes.")

    def authorize(operation, paths):
        absolute = [absolute_path(item) for item in paths]
        result = request("workspace.authorize", {"operation": operation, "paths": absolute})
        status = result["status"]
        if status == "pending":
            error = policy_pending("Outside-root access is awaiting an operator decision.")
            error.detail = result
            raise error
        if status == "denied":
            error = policy_denied("Outside-root access was denied by the operator.")
            error.detail = result
            raise error
        return result

    def record(operation, paths):
        return request("effect.record", {"operation": operation, "paths": paths})

    # A dry run's workspace writes (spec #13 D4): reported to Node and skipped, with no outside-root decision.
    def skip(operation, paths):
        absolute = [fsdecode(abspath(fspath(item))) for item in paths]
        request("file.skip", {"operation": operation, "paths": absolute})
        return absolute

    def writes(mode):
        return is_instance(mode, string_type) and any(flag in string_value(mode) for flag in "wax+")

    def dry_open(file, mode="r", buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None):
        if is_instance(file, int) or not writes(mode):
            return original_open(file, mode, buffering, encoding, errors, newline, closefd, opener)
        (target,) = skip("write_file", [file])
        sink = skipped_binary() if "b" in string_value(mode) else skipped_text()
        sink.name = target
        sink.mode = string_value(mode)
        return sink

    def dry_os_open(path, flags, mode=0o777, *args, **kwargs):
        if integer_and(flags, write_flags):
            raise refused("os.open for writing cannot be skipped in a dry run; write with open() or files.write, which a dry run skips and lists.")
        return original_os_open(path, flags, mode, *args, **kwargs)

    def dry_rename(source, destination):
        return skip("rename_file", [source, destination])[1]

    def dry_move(source, destination):
        return skip("move_file", [source, destination])[1]

    def dry_delete(path):
        return skip("delete_file", [path])[0]

    def dry_remove(path, *args, **kwargs):
        skip("delete_file", [path])

    def dry_rmdir(path, *args, **kwargs):
        skip("delete_directory", [path])

    def dry_mkdir(path, mode=0o777, *args, **kwargs):
        skip("write_directory", [path])

    def dry_makedirs(name, mode=0o777, exist_ok=False):
        skip("write_directory", [name])

    def profile(frame, event, arg):
        if event == "c_call":
            call_stack.append([arg, None])
            return
        if event not in {"c_return", "c_exception"} or not call_stack:
            return
        _, effect = call_stack.pop()
        if event == "c_return" and effect:
            record(*effect)

    def trace(frame, event, arg):
        if event == "call":
            return trace if frame.f_code.co_filename == trusted_filename else None
        if event == "exception":
            exception_setattr(arg[1], "__traceback__", None)
            exception_setattr(arg[1], "__context__", None)
            exception_setattr(arg[1], "__cause__", None)
        return trace

    def protected_profile(*args):
        raise RuntimeError("Execution profiling is managed by the Drive It worker.")

    def protected_getprofile():
        return None

    def protected_trace(*args):
        raise RuntimeError("Execution tracing is managed by the Drive It worker.")

    def protected_gettrace():
        return None

    def file_rename(source, destination):
        original_functions["rename"](source, destination)
        return abspath(fspath(destination))

    def file_move(source, destination):
        original_functions["rename"](source, destination)
        return abspath(fspath(destination))

    def file_replace(source, destination):
        original_functions["replace"](source, destination)
        return abspath(fspath(destination))

    def file_delete(path):
        is_directory = stat_module.S_ISDIR(original_functions["stat"](path).st_mode)
        function = original_functions["rmdir"] if is_directory else original_functions["remove"]
        function(path)
        return abspath(fspath(path))

    def importing(name, globals=None, locals=None, fromlist=(), level=0):
        if getframe(1).f_code.co_filename == SCRIPT_FILENAME and (level or name not in ALLOWED_MODULES):
            raise ImportError(IMPORT_DISABLED)
        return original_import(name, globals, locals, fromlist, level)

    def audit(event, arguments):
        if event == "import" and not _import_allowed(arguments[0]):
            raise ImportError(IMPORT_DISABLED)
        if event in {
            "_winapi.CreateProcess",
            "os.exec",
            "os.fork",
            "os.forkpty",
            "os.posix_spawn",
            "os.posix_spawnp",
            "os.spawn",
            "os.startfile",
            "os.system",
            "pty.spawn",
            "subprocess.Popen",
        }:
            raise RuntimeError("Process execution is disabled in the Drive It worker.")
        if event in {"open", "os.listdir", "os.scandir"}:
            frame = getframe(1)
            # A module load the import hook let through; the bundled Python reads its standard library from a zip.
            if frame.f_code.co_filename.startswith(("<frozen importlib", "<frozen zipimport")):
                while frame:
                    if frame.f_code is importing.__code__:
                        return
                    frame = frame.f_back

        paths = []
        if event == "open":
            file, mode, flags = arguments
            if is_instance(file, int):
                return
            if is_instance(mode, string_type):
                mode = string_value(mode)
            operation = "write_file" if (mode and any(flag in mode for flag in "wax+")) or integer_and(flags, write_flags) else "read_file"
            paths = [file]
        elif event in {"os.rename", "os.link", "os.symlink"}:
            operation = "rename_file" if event == "os.rename" else "link_file"
            if event == "os.rename":
                frame = getframe(1)
                while frame:
                    if frame.f_code in {file_move.__code__, file_replace.__code__}:
                        operation = "move_file"
                        break
                    frame = frame.f_back
            paths = list(arguments[:2])
        else:
            operations = {
                "os.remove": "delete_file",
                "os.rmdir": "delete_directory",
                "os.unlink": "delete_file",
                "os.truncate": "write_file",
                "os.mkdir": "write_directory",
                "os.mkfifo": "write_file",
                "os.mknod": "write_file",
                "os.chmod": "write_metadata",
                "os.chown": "write_metadata",
                "os.listdir": "read_directory",
                "os.scandir": "read_directory",
            }
            operation = operations.get(event)
            if event == "os.rmdir":
                frame = getframe(1)
                while frame:
                    if frame.f_code is file_delete.__code__:
                        operation = "delete_file"
                        break
                    frame = frame.f_back
            if operation:
                paths = [arguments[0]]
        if not operation:
            return
        # A write that reached the hook in a dry run came by a route the dry run cannot skip: refuse it.
        if dry_run and not operation.startswith("read_"):
            raise refused(f"This {operation} cannot be skipped in a dry run; write with open(), os or files.*, which a dry run skips and lists.")
        result = authorize(operation, paths)
        if call_stack:
            call_stack[-1][1] = (operation, result["requests"][0]["paths"])

    # Dev Mode: no audit hook, so no file mediation, process refusal or import check; files.* are plain I/O.
    if enforce:
        sys.addaudithook(audit)
        sys.setprofile(profile)
        sys.setprofile = protected_profile
        sys.getprofile = protected_getprofile
        sys.settrace(trace)
        sys.settrace = protected_trace
        sys.gettrace = protected_gettrace
    policy = {
        "open": original_open,
        "os_open": original_os_open,
        "import": importing,
        "rename": file_rename,
        "move": file_move,
        "delete": file_delete,
        **{name: function for name, function in original_functions.items() if name not in {"rename", "replace"}},
        "rename_os": original_functions["rename"],
        "replace": file_replace,
    }
    if dry_run:
        # files.* use these in both modes; standard mode also installs them over open() and os (Dev Mode does not).
        policy.update({
            "open": dry_open,
            "os_open": dry_os_open,
            "rename": dry_rename,
            "move": dry_move,
            "delete": dry_delete,
            "rename_os": lambda source, destination, *args, **kwargs: skip("rename_file", [source, destination]) and None,
            "replace": lambda source, destination, *args, **kwargs: skip("move_file", [source, destination]) and None,
            "remove": dry_remove,
            "unlink": dry_remove,
            "rmdir": dry_rmdir,
            "mkdir": dry_mkdir,
            "makedirs": dry_makedirs,
        })
    return policy


def _disabled(*args, **kwargs):
    raise RuntimeError("Process execution is disabled in the Drive It worker.")


def _disabled_thread(*args, **kwargs):
    raise RuntimeError("Thread execution is disabled in the Drive It worker.")


class Files:
    def __init__(self, policy):
        self.policy = policy

    def read(self, path, encoding="utf-8"):
        with self.policy["open"](path, "r", encoding=encoding) as handle:
            return handle.read()

    def write(self, path, content, encoding="utf-8"):
        with self.policy["open"](path, "w", encoding=encoding) as handle:
            handle.write(content)
            return handle.name

    def rename(self, source, destination):
        return self.policy["rename"](source, destination)

    def move(self, source, destination):
        return self.policy["move"](source, destination)

    def delete(self, path):
        return self.policy["delete"](path)


class Checks:
    def record(self, name, passed, observed=None):
        check = {"name": str(name), "passed": bool(passed), "observed": observed}
        _checks.append(check)
        _request("check.record", check)
        return check["passed"]


class Units:
    """Converts between display units and Revit's internal units (feet, square feet, radians)."""

    # Internal units per one of each unit.
    FACTORS = {
        "mm": 1 / 304.8, "cm": 1 / 30.48, "m": 1 / 0.3048, "in": 1 / 12, "ft": 1.0,
        "mm2": 1 / 92903.04, "m2": 1 / 0.09290304, "in2": 1 / 144, "ft2": 1.0,
        "deg": math.pi / 180, "rad": 1.0,
    }

    def _factor(self, unit):
        if unit not in self.FACTORS:
            raise ValueError(f"Unknown unit {unit!r}; valid units are {', '.join(self.FACTORS)}.")
        return self.FACTORS[unit]

    def to_internal(self, value, unit):
        return value * self._factor(unit)

    def from_internal(self, value, unit):
        return value / self._factor(unit)


class Revit:
    options = _Options()
    OPERATIONS = {
        "open_document", "create_document", "read_document", "save_document",
        "save_as_document", "close_document", "delete_document", "create_level",
        "create_wall", "create_3d_view", "create_family_type", "delete_element",
        "get_active_document", "find_elements", "get_parameters", "list_types",
        "list_views", "get_selection", "set_selection", "set_parameters",
        "get_family_parameters", "set_family_parameters", "edit_family",
    }
    # Read primitives return their output (the broker's results entry) instead of the full response.
    READ_PRIMITIVES = {
        "find_elements", "get_parameters", "list_types", "list_views", "get_selection", "get_family_parameters",
    }

    def __init__(self, process_id, document, policy_pending, policy_denied):
        self.process_id = process_id
        self._current = document
        self._policy_pending = policy_pending
        self._policy_denied = policy_denied

    def execute(self, operations, document=None):
        normalized = []
        for operation in operations:
            arguments = dict(operation.get("arguments") or {})
            for key in ("path", "destinationPath", "templatePath"):
                if isinstance(arguments.get(key), str):
                    arguments[key] = os.path.abspath(arguments[key])
            normalized.append({"type": operation["type"], "arguments": arguments})
        response = _request("broker.execute", {
            "processId": self.process_id,
            "document": document if document is not None else self._current,
            "operations": normalized,
        })
        status = response.get("status")
        if status == "pending":
            error = self._policy_pending("Outside-root access is awaiting an operator decision.")
            error.detail = response
            raise error
        if status == "denied":
            error = self._policy_denied("Outside-root access was denied by the operator.")
            error.detail = response
            raise error
        if status != "succeeded":
            raise RevitError(response)
        if normalized and normalized[-1]["type"] in ("close_document", "delete_document"):
            # The closed document's handle is stale; later calls must open or create another.
            self._current = None
        elif response.get("document"):
            self._current = response["document"]
        return response

    def _primitive(self, name, document, arguments):
        arguments = {key: value for key, value in arguments.items() if value is not None}
        response = self.execute([{"type": name, "arguments": arguments}], document=document)
        return response["results"][0] if name in self.READ_PRIMITIVES else response

    def get_active_document(self, document=None):
        return self._primitive("get_active_document", document, {})

    def find_elements(self, category, kind="instance", levelId=None, typeName=None, limit=200, offset=0, document=None):
        return self._primitive("find_elements", document, {
            "category": category, "kind": kind, "levelId": levelId, "typeName": typeName, "limit": limit, "offset": offset,
        })

    def get_parameters(self, elementIds, names=None, includeType=True, document=None):
        return self._primitive("get_parameters", document, {"elementIds": elementIds, "names": names, "includeType": includeType})

    def list_types(self, category, document=None):
        return self._primitive("list_types", document, {"category": category})

    def list_views(self, viewTypes=None, includeSheets=True, includeTemplates=False, document=None):
        return self._primitive("list_views", document, {
            "viewTypes": viewTypes, "includeSheets": includeSheets, "includeTemplates": includeTemplates,
        })

    def get_selection(self, document=None):
        return self._primitive("get_selection", document, {})

    def set_selection(self, elementIds, document=None):
        return self._primitive("set_selection", document, {"elementIds": elementIds})

    def set_parameters(self, changes, document=None):
        return self._primitive("set_parameters", document, {"changes": changes})

    def get_family_parameters(self, document=None):
        return self._primitive("get_family_parameters", document, {})

    def set_family_parameters(self, changes, document=None):
        return self._primitive("set_family_parameters", document, {"changes": changes})

    def edit_family(self, familyId, document=None):
        return self._primitive("edit_family", document, {"familyId": familyId})

    def _document_target(self, document):
        if document is None:
            document = self._current
        if isinstance(document, _Handle):
            return {"$h": object.__getattribute__(document, "_h_id")}
        if document is None or isinstance(document, dict):
            return document
        raise TypeError("document= takes a document from a receipt or a Document handle.")

    def document(self, document=None):
        """A handle to the script's current document, or the one a receipt's document names."""
        return _decode(_bridge({"op": "document", "document": self._document_target(document)}))

    def element(self, id, document=None):
        """A handle to one element by its integer id."""
        if isinstance(id, bool) or not isinstance(id, int):
            raise TypeError("revit.element takes an integer element id, e.g. element.Id.Value.")
        return _decode(_bridge({"op": "element", "id": id, "document": self._document_target(document)}))

    def transaction(self, name, document=None):
        """A with block; Revit changes go inside one. Leaving it commits; an exception rolls it back."""
        return _Transaction(self, name, document)

    def describe(self, name):
        """The members and signatures of a Revit API type, from the running Revit. Does not hold Revit."""
        if not isinstance(name, str):
            raise TypeError('revit.describe takes a type name, e.g. "FamilyItemFactory".')
        return _bridge({"op": "describe", "type": name})

    def __getattr__(self, name):
        if name not in self.OPERATIONS:
            raise AttributeError(name)
        def call(document=None, **arguments):
            return self.execute([{"type": name, "arguments": arguments}], document=document)
        return call


def _serializable(value):
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return repr(value)


def _detach_protocol():
    """Dev Mode: a process a script starts inherits the worker's standard handles. The protocol moves to
    descriptors of its own that no child inherits; standard input becomes NUL and standard output goes to
    stderr, so a child can neither read the protocol nor write into it.

    The protocol input re-opens descriptor 0 directly, so it relies on sys.stdin having buffered nothing past
    the run line. That holds because Node writes nothing more until the worker sends its first request."""
    global _protocol_in, _protocol_out
    _protocol_in = open(os.dup(0), "r", encoding="utf-8")
    _protocol_out = open(os.dup(1), "w", encoding="utf-8", newline="\n")
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    os.close(null)
    os.dup2(2, 1)


def _restrict(policy):
    """Standard mode's guardrails on the running interpreter: mediated files, the import check, no processes or threads."""
    builtins.open = policy["open"]
    builtins.__import__ = policy["import"]
    io.open = policy["open"]
    os.open = policy["os_open"]
    os.stat = policy["stat"]
    os.lstat = policy["lstat"]
    os.access = policy["access"]
    os.listdir = policy["listdir"]
    os.mkdir = policy["mkdir"]
    os.makedirs = policy["makedirs"]
    os.remove = policy["remove"]
    os.unlink = policy["unlink"]
    os.rmdir = policy["rmdir"]
    os.rename = policy["rename_os"]
    os.replace = policy["replace"]
    os.scandir = policy["scandir"]
    os.system = _disabled
    os.popen = _disabled
    if hasattr(os, "startfile"):
        os.startfile = _disabled
    for name in dir(os):
        if name.startswith(("spawn", "exec")):
            setattr(os, name, _disabled)
    for name in dir(_thread):
        if name.startswith(("start", "_start")):
            setattr(_thread, name, _disabled_thread)


def main():
    global _dev_mode, _dry_run
    run = json.loads(_protocol_in.readline())
    _dev_mode = run.get("mode") == "dev"
    _dry_run = run.get("dryRun") is True
    policy_pending = RuntimeError
    policy_denied = PermissionError
    if _dev_mode:
        _detach_protocol()
    else:
        # Load the allowlist (and its dependencies) before the hook freezes further loads.
        for name in sorted(ALLOWED_MODULES):
            try:
                __import__(name)
            except ImportError:
                pass
        sys.meta_path.insert(0, RuntimeRestriction())
    policy = _create_file_policy(_protocol_in, _protocol_out, policy_pending, policy_denied, enforce=not _dev_mode, dry_run=_dry_run)
    if not _dev_mode:
        _restrict(policy)

    receipt = {"status": "succeeded", "result": None, "error": None, "checks": _checks}
    stdout = io.StringIO()
    sys.stdout = stdout
    sys.stderr = stdout
    try:
        scope = {
            "__builtins__": builtins,
            "__name__": "__main__",
            "args": run.get("arguments") or {},
            "files": Files(policy),
            "revit": Revit(run["processId"], run.get("document"), policy_pending, policy_denied),
            "checks": Checks(),
            "units": Units(),
            "DB": _Path("Autodesk.Revit.DB"),
            "RevitError": RevitError,
            "result": None,
        }
        exec(compile(run["source"], "<drive-it-script>", "exec"), scope)
        receipt["result"] = _serializable(scope.get("result"))
    # Before policy_pending: a DryRunRefused is a RuntimeError too.
    except DryRunRefused as error:
        receipt["status"] = "failed"
        receipt["error"] = {"code": DryRunRefused.code, "message": str(error)}
    except policy_pending as error:
        if hasattr(error, "detail"):
            receipt["status"] = "pending"
            receipt["policy"] = error.detail
        else:
            receipt["status"] = "failed"
            receipt["error"] = {"code": "SCRIPT_FAILED", "message": str(error), "type": type(error).__name__}
    except policy_denied as error:
        if hasattr(error, "detail"):
            receipt["status"] = "denied"
            receipt["policy"] = error.detail
            receipt["error"] = {"code": "OUTSIDE_ROOT_DENIED", "message": str(error)}
        else:
            receipt["status"] = "failed"
            receipt["error"] = {"code": "SCRIPT_FAILED", "message": str(error), "type": type(error).__name__}
    except RevitError as error:
        receipt["status"] = error.response.get("status", "failed")
        receipt["error"] = error.response.get("error") or {"code": "REVIT_EXECUTION_FAILED", "message": str(error)}
    except SystemExit as error:
        if error.code is not None and (not isinstance(error.code, int) or error.code != 0):
            receipt["status"] = "failed"
            receipt["error"] = {"code": "SCRIPT_FAILED", "message": str(error), "type": type(error).__name__}
    except Exception as error:
        receipt["status"] = "failed"
        receipt["error"] = {"code": "SCRIPT_FAILED", "message": str(error), "type": type(error).__name__}
    finally:
        sys.stdout = _protocol_out
        sys.stderr = sys.__stderr__
        receipt["logs"] = stdout.getvalue()
        receipt["checks"] = _checks
        _protocol_out.write(json.dumps({"type": "final", "receipt": receipt}) + "\n")
        _protocol_out.flush()


if __name__ == "__main__":
    main()
