import builtins
import importlib.abc
import io
import json
import math
import os
import stat as stat_module
import sys
import _thread

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
IMPORT_DISABLED = "Package installation, process and thread execution, and native loading are disabled in the Drive It worker; only allowlisted modules can be imported."
SCRIPT_FILENAME = "<drive-it-script>"


PolicyPending = RuntimeError
PolicyDenied = PermissionError


class RevitError(Exception):
    def __init__(self, response):
        error = response.get("error") or {}
        super().__init__(error.get("message") or "Revit broker execution failed.")
        self.response = response


class RuntimeRestriction(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname not in ALLOWED_MODULES:
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


def _create_file_policy(protocol_in, protocol_out, policy_pending, policy_denied):
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
        if event == "import" and arguments[0] not in ALLOWED_MODULES:
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
            if frame.f_code.co_filename.startswith("<frozen importlib"):
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
        result = authorize(operation, paths)
        if call_stack:
            call_stack[-1][1] = (operation, result["requests"][0]["paths"])

    sys.addaudithook(audit)
    sys.setprofile(profile)
    sys.setprofile = protected_profile
    sys.getprofile = protected_getprofile
    sys.settrace(trace)
    sys.settrace = protected_trace
    sys.gettrace = protected_gettrace
    return {
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
    OPERATIONS = {
        "open_document", "create_document", "read_document", "save_document",
        "save_as_document", "close_document", "delete_document", "create_level",
        "create_wall", "create_3d_view", "create_family_type", "delete_element",
        "get_active_document", "find_elements", "get_parameters", "list_types",
        "list_views", "get_selection", "set_selection", "set_parameters",
    }
    # Read primitives return their output (the broker's results entry) instead of the full response.
    READ_PRIMITIVES = {"find_elements", "get_parameters", "list_types", "list_views", "get_selection"}

    def __init__(self, process_id, document, policy_pending, policy_denied):
        self.process_id = process_id
        self.document = document
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
            "document": document if document is not None else self.document,
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
            self.document = None
        elif response.get("document"):
            self.document = response["document"]
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


def main():
    run = json.loads(_protocol_in.readline())
    policy_pending = RuntimeError
    policy_denied = PermissionError
    # Load the allowlist (and its dependencies) before the hook freezes further loads.
    for name in sorted(ALLOWED_MODULES):
        try:
            __import__(name)
        except ImportError:
            pass
    sys.meta_path.insert(0, RuntimeRestriction())
    policy = _create_file_policy(_protocol_in, _protocol_out, policy_pending, policy_denied)
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
            "result": None,
        }
        exec(compile(run["source"], "<drive-it-script>", "exec"), scope)
        receipt["result"] = _serializable(scope.get("result"))
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
