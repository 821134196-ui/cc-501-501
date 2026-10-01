"""标准库 HTTP 服务:JSON API + 静态页面。每次请求独立 SQLite 连接,线程安全。"""
import json
import os
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import db, services
from .services import BizError

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")


class App:
    def __init__(self, db_path, upload_dir, sample_dir):
        self.db_path = db_path
        self.upload_dir = upload_dir
        self.sample_dir = sample_dir

    def conn(self):
        return db.connect(self.db_path)


def _json(handler, code, obj):
    body = json.dumps(obj, ensure_ascii=False,
                      default=lambda o: dict(o) if isinstance(o, sqlite3.Row) else str(o)
                      ).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # 静音访问日志
            pass

        # ------------------------------------------------ 工具
        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(n) if n else b""

        def _json_body(self):
            raw = self._body()
            return json.loads(raw.decode("utf-8")) if raw else {}

        def _route(self, method):
            m = re.match(r"^/api/orders(?:/(\d+)(?:/(files|reprint|reduce|pickup))?)?$", self.path)
            if m:
                oid = int(m.group(1)) if m.group(1) else None
                sub = m.group(2)
                if method == "GET" and oid is None:
                    return self._ok(services.list_orders(self._c()))
                if method == "POST" and oid is None:
                    return self._ok(services.create_order(self._c(), self._json_body()), 201)
                if method == "GET" and oid and sub is None:
                    return self._ok(services.order_detail(self._c(), oid))
                if method == "POST" and oid and sub == "files":
                    return self._upload(oid)
                if method == "POST" and oid and sub == "reprint":
                    b = self._json_body()
                    return self._ok(services.reprint(self._c(), oid, b.get("reason", ""),
                                                     b.get("note", ""), b.get("operator", "")), 201)
                if method == "POST" and oid and sub == "reduce":
                    b = self._json_body()
                    return self._ok(services.reduce_copies(self._c(), oid, b.get("copies", 0)))
                if method == "POST" and oid and sub == "pickup":
                    b = self._json_body()
                    return self._ok(services.pickup(self._c(), oid, b.get("operator", ""),
                                                    b.get("customer", "")), 201)
            m = re.match(r"^/api/proofs/(\d+)/(confirm|annotations)$", self.path)
            if m and method == "POST":
                pid = int(m.group(1))
                if m.group(2) == "confirm":
                    return self._ok(services.confirm_proof(self._c(), pid))
                b = self._json_body()
                return self._ok(services.add_annotation(
                    self._c(), pid, b.get("author", "shop"),
                    b.get("x_mm", 0), b.get("y_mm", 0), b.get("text", "")), 201)
            m = re.match(r"^/api/files/(\d+)$", self.path)
            if m and method == "GET":
                return self._file(int(m.group(1)))
            m = re.match(r"^/api/tasks/(\d+)/(claim|complete|jam)$", self.path)
            if m and method == "POST":
                tid, action = int(m.group(1)), m.group(2)
                if action == "claim":
                    task, job = services.claim_task(self._c(), tid, self._json_body().get("operator", ""))
                    return self._ok({"task": dict(task), "job": job})
                if action == "complete":
                    return self._ok(services.complete_task(self._c(), tid))
                task, info = services.jam_task(self._c(), tid)
                return self._ok({"task": dict(task), "printer": info})
            if self.path == "/api/devices" and method == "GET":
                return self._ok(services.devices_view(self._c()))
            if self.path == "/api/samples" and method == "GET":
                return self._ok(sorted(os.listdir(app.sample_dir)))
            if self.path == "/api/meta" and method == "GET":
                return self._ok({
                    "paper_sizes": services.PAPER_SIZES,
                    "page_price": services.PAGE_PRICE,
                    "binding_label": services.BINDING_LABEL,
                    "reprint_reasons": services.REPRINT_REASON_LABEL,
                    "reprint_rules": {k: {"handling": v[0], "ratio": v[1], "text": v[2]}
                                      for k, v in services.REPRINT_RULES.items()},
                    "status_label": services.ORDER_STATUS_LABEL,
                })
            raise BizError("接口不存在", 404)

        _conn = None

        def _c(self):
            if self._conn is None:
                self._conn = app.conn()
            return self._conn

        def _ok(self, obj, code=200):
            _json(self, code, obj)

        def _upload(self, oid):
            ctype = self.headers.get("Content-Type", "")
            if "application/json" in ctype:
                b = self._json_body()
                name = b.get("sample", "")
                path = os.path.join(app.sample_dir, os.path.basename(name))
                if not os.path.isfile(path):
                    raise BizError("样例文件不存在", 404)
                with open(path, encoding="utf-8") as f:
                    text = f.read()
                filename = os.path.basename(name)
            else:
                filename = self.headers.get("X-Filename") or "upload.svg"
                text = self._body().decode("utf-8")
            v = services.attach_file(self._c(), oid, filename, text, app.upload_dir)
            d = dict(v)
            d["precheck"] = json.loads(v["precheck_json"])
            d.pop("precheck_json", None)
            return self._ok(d, 201)

        def _file(self, version_id):
            v = db.one(self._c(), "SELECT * FROM file_versions WHERE id=?", (version_id,))
            if not v or not os.path.isfile(v["path"]):
                raise BizError("文件不存在", 404)
            with open(v["path"], "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _static(self):
            path = os.path.join(STATIC_DIR, "index.html")
            with open(path, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _dispatch(self, method):
            try:
                if self.path == "/" or self.path.startswith("/index.html"):
                    return self._static()
                return self._route(method)
            except BizError as e:
                _json(self, e.status, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                _json(self, 500, {"error": f"服务器内部错误:{e}"})
            finally:
                if self._conn is not None:
                    self._conn.close()
                    self._conn = None

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

    return Handler


def serve(app, host="127.0.0.1", port=8000):
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    print(f"服务已启动: http://{host}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
