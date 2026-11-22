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


def _authorize(operation, paths):
    absolute = [os.path.abspath(os.fspath(item)) for item in paths]
    result = _request("workspace.authorize", {"operation": operation, "paths": absolute})
    status = result["status"]
    if status == "pending":
        raise PolicyPending(result)
    if status == "denied":
        raise PolicyDenied(result)
    return result


def _record(operation, paths):
    return _request("effect.record", {"operation": operation, "paths": paths})


def _policy_open(file, mode="r", *args, **kwargs):
    operation = "read_file" if all(flag not in mode for flag in "wax+") else "write_file"
    result = _authorize(operation, [file])
    canonical = result["requests"][0]["paths"][0]
    handle = _original_open(canonical, mode, *args, **kwargs)
    _record(operation, [canonical])
    return handle


def _policy_io_open(file, mode="r", *args, **kwargs):
    return _policy_open(file, mode, *args, **kwargs)


def _policy_os_open(file, flags, *args, **kwargs):
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
    operation = "write_file" if flags & write_flags else "read_file"
    result = _authorize(operation, [file])
    canonical = result["requests"][0]["paths"][0]
    descriptor = _original_os_open(canonical, flags, *args, **kwargs)
    _record(operation, [canonical])
    return descriptor


def _one(operation, function):
    def wrapped(path, *args, **kwargs):
        result = _authorize(operation, [path])
        canonical = result["requests"][0]["paths"][0]
        observed = function(canonical, *args, **kwargs)
        _record(operation, [canonical])
        return observed
    return wrapped


def _two(operation, function):
    def wrapped(source, destination, *args, **kwargs):
        result = _authorize(operation, [source, destination])
        canonical = result["requests"][0]["paths"]
        observed = function(canonical[0], canonical[1], *args, **kwargs)
        _record(operation, canonical)
        return observed
    return wrapped


def _disabled(*args, **kwargs):
    raise RuntimeError("Process execution is disabled in the Drive It worker.")


class Files:
    def read(self, path, encoding="utf-8"):
        result = _authorize("read_file", [path])
        canonical = result["requests"][0]["paths"][0]
        with _original_open(canonical, "r", encoding=encoding) as handle:
            content = handle.read()
        _record("read_file", [canonical])
        return content

    def write(self, path, content, encoding="utf-8"):
        result = _authorize("write_file", [path])
        canonical = result["requests"][0]["paths"][0]
        with _original_open(canonical, "w", encoding=encoding) as handle:
            handle.write(content)
        _record("write_file", [canonical])
        return canonical

    def rename(self, source, destination):
        result = _authorize("rename_file", [source, destination])
        canonical = result["requests"][0]["paths"]
        _original_rename(canonical[0], canonical[1])
        _record("rename_file", canonical)
        return canonical[1]

    def move(self, source, destination):
        result = _authorize("move_file", [source, destination])
        canonical = result["requests"][0]["paths"]
        _original_rename(canonical[0], canonical[1])
        _record("move_file", canonical)
        return canonical[1]

    def delete(self, path):
        result = _authorize("delete_file", [path])
        canonical = result["requests"][0]["paths"][0]
        if stat_module.S_ISDIR(_original_stat(canonical).st_mode):
            _original_rmdir(canonical)
        else:
            _original_remove(canonical)
        _record("delete_file", [canonical])
        return canonical


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
    builtins.open = _policy_open
    io.open = _policy_io_open
    os.open = _policy_os_open
    os.stat = _one("read_metadata", _original_stat)
    os.lstat = _one("read_metadata", _original_lstat)
    os.access = _one("read_metadata", _original_access)
    os.listdir = _one("read_directory", _original_listdir)
    os.mkdir = _one("write_directory", _original_mkdir)
    os.makedirs = _one("write_directory", _original_makedirs)
    os.remove = _one("delete_file", _original_remove)
    os.unlink = _one("delete_file", _original_unlink)
    os.rmdir = _one("delete_directory", _original_rmdir)
    os.rename = _two("rename_file", _original_rename)
    os.replace = _two("move_file", _original_replace)
    os.scandir = _one("read_directory", _original_scandir)
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
            "files": Files(),
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
