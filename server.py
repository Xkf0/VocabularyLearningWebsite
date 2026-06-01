"""
艾宾浩斯背单词 - 本地服务器
启动后访问 http://localhost:3000
自动读写 vocabulary-data.json
"""
import http.server
import json
import os
import sys
import webbrowser
import threading
import time

PORT = 3000
DATA_FILE = os.path.join(os.path.dirname(__file__), 'vocabulary-data.json')


class Handler(http.server.SimpleHTTPRequestHandler):
    """同时提供静态文件服务和 /api/words 读写接口"""

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def do_GET(self):
        if self.path == '/api/words':
            if os.path.exists(DATA_FILE):
                try:
                    with open(DATA_FILE, 'r', encoding='utf-8') as f:
                        text = f.read()
                    data = json.loads(text) if text.strip() else []
                except (json.JSONDecodeError, IOError):
                    data = []
            else:
                data = []
            self._send_json(data)
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == '/api/words':
            try:
                length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(length).decode('utf-8')
                data = json.loads(body)

                with open(DATA_FILE, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)

                self._send_json({'ok': True, 'count': len(data)})
            except Exception as e:
                self._send_json({'ok': False, 'error': str(e)}, 500)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, format, *args):
        # 过滤掉 /api/words 的频繁日志，保持终端干净
        if '/api/words' in str(args):
            return
        super().log_message(format, *args)


if __name__ == '__main__':
    # 切换到脚本所在目录，确保相对路径正确
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = http.server.HTTPServer(('0.0.0.0', PORT), Handler)
    print(f'''
  ╔═══════════════════════════════════════════╗
  ║   艾宾浩斯背单词 · 本地服务器              ║
  ║                                           ║
  ║   访问地址: http://localhost:{PORT}          ║
  ║   数据文件: vocabulary-data.json           ║
  ║                                           ║
  ║   按 Ctrl+C 停止服务器                     ║
  ╚═══════════════════════════════════════════╝
    ''')

    # 自动打开浏览器
    threading.Thread(target=lambda: (time.sleep(1), webbrowser.open(f'http://localhost:{PORT}')), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n服务器已停止')
        server.server_close()
        sys.exit(0)