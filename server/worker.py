import builtins
import importlib.abc
import io
import json
import os
import stat as stat_module
import sys

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


class PolicyPending(Exception):
    def __init__(self, detail):
        super().__init__("Outside-root access is awaiting an operator decision.")
        self.detail = detail


class PolicyDenied(Exception):
    def __init__(self, detail):
        super().__init__("Outside-root access was denied by the operator.")
        self.detail = detail


class RevitError(Exception):
    def __init__(self, response):
        error = response.get("error") or {}
        super().__init__(error.get("message") or "Revit broker execution failed.")
        self.response = response


class RuntimeRestriction(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in {"pip", "ensurepip", "setuptools", "subprocess", "ctypes"}:
            raise ImportError("Package installation, process execution, and native loading are disabled in the Drive It worker.")
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


def _create_file_policy(protocol_in, protocol_out):
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
    request_id = 0
    mediated_depth = 0
    import_depth = 0

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

    def authorize(operation, paths):
        absolute = [abspath(fspath(item)) for item in paths]
        result = request("workspace.authorize", {"operation": operation, "paths": absolute})
        status = result["status"]
        if status == "pending":
            raise PolicyPending(result)
        if status == "denied":
            raise PolicyDenied(result)
        return result

    def record(operation, paths):
        return request("effect.record", {"operation": operation, "paths": paths})

    def mediate(function, *args, **kwargs):
        nonlocal mediated_depth
        mediated_depth += 1
        try:
            return function(*args, **kwargs)
        finally:
            mediated_depth -= 1

    def policy_open(file, mode="r", *args, **kwargs):
        operation = "read_file" if all(flag not in mode for flag in "wax+") else "write_file"
        result = authorize(operation, [file])
        canonical = result["requests"][0]["paths"][0]
        handle = mediate(original_open, canonical, mode, *args, **kwargs)
        record(operation, [canonical])
        return handle

    def policy_os_open(file, flags, *args, **kwargs):
        operation = "write_file" if flags & write_flags else "read_file"
        result = authorize(operation, [file])
        canonical = result["requests"][0]["paths"][0]
        descriptor = mediate(original_os_open, canonical, flags, *args, **kwargs)
        record(operation, [canonical])
        return descriptor

    def one(operation, function):
        def wrapped(path, *args, **kwargs):
            result = authorize(operation, [path])
            canonical = result["requests"][0]["paths"][0]
            observed = mediate(function, canonical, *args, **kwargs)
            record(operation, [canonical])
            return observed
        return wrapped

    def two(operation, function):
        def wrapped(source, destination, *args, **kwargs):
            result = authorize(operation, [source, destination])
            canonical = result["requests"][0]["paths"]
            observed = mediate(function, canonical[0], canonical[1], *args, **kwargs)
            record(operation, canonical)
            return observed
        return wrapped

    def file_rename(operation, source, destination):
        result = authorize(operation, [source, destination])
        canonical = result["requests"][0]["paths"]
        mediate(original_functions["rename"], canonical[0], canonical[1])
        record(operation, canonical)
        return canonical[1]

    def file_delete(path):
        result = authorize("delete_file", [path])
        canonical = result["requests"][0]["paths"][0]
        is_directory = stat_module.S_ISDIR(mediate(original_functions["stat"], canonical).st_mode)
        function = original_functions["rmdir"] if is_directory else original_functions["remove"]
        mediate(function, canonical)
        record("delete_file", [canonical])
        return canonical

    def importing(*args, **kwargs):
        nonlocal import_depth
        import_depth += 1
        try:
            return original_import(*args, **kwargs)
        finally:
            import_depth -= 1

    def audit(event, arguments):
        if mediated_depth:
            return
        if import_depth and event in {"open", "os.listdir", "os.scandir"}:
            frame = getframe(1)
            if frame.f_code.co_filename.startswith("<frozen importlib"):
                return

        paths = []
        if event == "open":
            file, mode, flags = arguments
            if isinstance(file, int):
                return
            operation = "write_file" if (mode and any(flag in mode for flag in "wax+")) or flags & write_flags else "read_file"
            paths = [file]
        elif event in {"os.rename", "os.link", "os.symlink"}:
            operation = "rename_file" if event == "os.rename" else "link_file"
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
            if operation:
                paths = [arguments[0]]
        if not operation:
            return
        result = authorize(operation, paths)
        record(operation, result["requests"][0]["paths"])

    sys.addaudithook(audit)
    return {
        "open": policy_open,
        "os_open": policy_os_open,
        "import": importing,
        "rename": lambda source, destination: file_rename("rename_file", source, destination),
        "move": lambda source, destination: file_rename("move_file", source, destination),
        "delete": file_delete,
        **{name: one("read_metadata" if name in {"stat", "lstat", "access"} else "read_directory" if name in {"listdir", "scandir"} else "write_directory" if name in {"mkdir", "makedirs"} else "delete_directory" if name == "rmdir" else "delete_file", function)
           for name, function in original_functions.items() if name not in {"rename", "replace"}},
        "rename_os": two("rename_file", original_functions["rename"]),
        "replace": two("move_file", original_functions["replace"]),
    }


def _disabled(*args, **kwargs):
    raise RuntimeError("Process execution is disabled in the Drive It worker.")


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


class Revit:
    OPERATIONS = {
        "open_document", "create_document", "read_document", "save_document",
        "save_as_document", "close_document", "delete_document", "create_level",
        "create_wall", "create_family_type", "delete_element",
    }

    def __init__(self, process_id, document):
        self.process_id = process_id
        self.document = document

    def execute(self, operations, document=None):
        normalized = []
        for operation in operations:
            arguments = dict(operation.get("arguments") or {})
            for key in ("path", "templatePath"):
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
            raise PolicyPending(response)
        if status == "denied":
            raise PolicyDenied(response)
        if status != "succeeded":
            raise RevitError(response)
        if response.get("document"):
            self.document = response["document"]
        return response

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
    sys.meta_path.insert(0, RuntimeRestriction())
    policy = _create_file_policy(_protocol_in, _protocol_out)
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
    for name in dir(os):
        if name.startswith(("spawn", "exec")):
            setattr(os, name, _disabled)

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
            "revit": Revit(run["processId"], run.get("document")),
            "checks": Checks(),
            "result": None,
        }
        exec(compile(run["source"], "<drive-it-script>", "exec"), scope)
        receipt["result"] = _serializable(scope.get("result"))
    except PolicyPending as error:
        receipt["status"] = "pending"
        receipt["policy"] = error.detail
    except PolicyDenied as error:
        receipt["status"] = "denied"
        receipt["policy"] = error.detail
        receipt["error"] = {"code": "OUTSIDE_ROOT_DENIED", "message": str(error)}
    except RevitError as error:
        receipt["status"] = error.response.get("status", "failed")
        receipt["error"] = error.response.get("error") or {"code": "REVIT_EXECUTION_FAILED", "message": str(error)}
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
