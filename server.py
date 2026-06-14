"""
艾宾浩斯记忆助手 - 本地服务器（支持多用户登录）
启动后访问 http://localhost:3000
数据按用户隔离：vocabulary-data-{用户名}.json
"""
import http.server
import hashlib
import json
import os
import secrets
import socket
import sys
import threading
from datetime import datetime

PORT = 3000
USERS_FILE = os.path.join(os.path.dirname(__file__), 'users.json')
DATA_DIR = os.path.dirname(__file__)

# 线程锁，防止并发读写导致数据丢失
_users_lock = threading.Lock()
_data_locks = {}
_data_locks_lock = threading.Lock()


def _get_user_data_lock(username):
    with _data_locks_lock:
        if username not in _data_locks:
            _data_locks[username] = threading.Lock()
        return _data_locks[username]


def _load_json(path):
    if not os.path.exists(path):
        return {} if path.endswith('.json') else []
    try:
        with open(path, 'r', encoding='utf-8') as f:
            text = f.read()
        return json.loads(text) if text.strip() else ({} if path.endswith('.json') else [])
    except (json.JSONDecodeError, IOError):
        return {} if path.endswith('.json') else []


def _save_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _hash_password(password):
    return hashlib.sha256(password.encode('utf-8')).hexdigest()


def _load_users():
    return _load_json(USERS_FILE)


def _save_users(users):
    _save_json(USERS_FILE, users)


def _get_user_data_file(username):
    return os.path.join(DATA_DIR, f'vocabulary-data-{username}.json')


def _read_user_data(username):
    """读取某个用户的数据，返回 {words, sentences, mathProblems, problems, methods}"""
    path = _get_user_data_file(username)
    data = _load_json(path)
    if isinstance(data, list):
        return {'words': data, 'sentences': [], 'methods': []}
    return {'words': data.get('words', []), 'sentences': data.get('sentences', []), 'mathProblems': data.get('mathProblems', []), 'problems': data.get('problems', []), 'methods': data.get('methods', [])}


def _merge_items(existing_items, incoming_items, key_field, fallback_field=None):
    """合并两个对象列表。

    以 incoming 为基准（客户端始终发送全量数据），
    同 key 时基于 lastModified 时间戳解决冲突：
      - 保留 lastModified 更新的版本（操作时间更近的胜出）
      - 如果 incoming 有 deletedAt 标记，但 existing 的 lastModified 更新，
        说明另一设备在删除后修改了该项目 → 恢复 existing（清除 deletedAt）
      - 对于没有 lastModified 的旧数据，回退到复习次数比较
    不在 incoming 中的旧数据视为已删除，不再保留。
    """
    result = {}
    # 先把 incoming 全量放入 result
    for item in incoming_items:
        k = str(item.get(key_field, '')).lower().strip()
        if not k and fallback_field:
            k = str(item.get(fallback_field, '')).lower().strip()
        if k:
            result[k] = item

    # 对每个 incoming，处理冲突
    for item in incoming_items:
        k = str(item.get(key_field, '')).lower().strip()
        if not k and fallback_field:
            k = str(item.get(fallback_field, '')).lower().strip()
        if not k:
            continue
        for existing in existing_items:
            ek = str(existing.get(key_field, '')).lower().strip()
            if not ek and fallback_field:
                ek = str(existing.get(fallback_field, '')).lower().strip()
            if ek == k:
                incoming_ts = item.get('lastModified') or ''
                existing_ts = existing.get('lastModified') or ''

                if incoming_ts and existing_ts:
                    # 基于时间戳比较
                    if item.get('deletedAt'):
                        # incoming 被删除，检查 existing 是否有更近期的修改
                        if existing_ts > incoming_ts:
                            # 另一台设备在删除之后复习/修改了该项目 → 恢复
                            restored = dict(existing)
                            restored.pop('deletedAt', None)
                            result[k] = restored
                        # 否则保留 deletedAt（删除确认，时间更近的操作胜出）
                    elif existing_ts > incoming_ts:
                        # existing 更新 → 保留 existing
                        result[k] = existing
                else:
                    # 没有 lastModified（旧数据兼容），使用原有的复习次数比较
                    existing_len = len(existing.get('reviewedAt', []))
                    incoming_len = len(item.get('reviewedAt', []))
                    existing_stage = existing.get('stage', 0)
                    incoming_stage = item.get('stage', 0)
                    if existing_len > incoming_len or (existing_len == incoming_len and existing_stage > incoming_stage):
                        result[k] = existing
                break

    return list(result.values())


class Handler(http.server.SimpleHTTPRequestHandler):

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Expose-Headers', 'Authorization')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def _get_token_user(self):
        """从 Authorization header 解析 token，返回用户名或 None"""
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer '):
            return None
        token = auth[7:].strip()
        if not token:
            return None
        users = _load_users()
        for username, info in users.items():
            if info.get('token') == token:
                return username
        return None

    # ---- 登录 / 注册 ----

    def do_AUTH(self):
        path = self.path
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length).decode('utf-8')) if length else {}

        if path == '/api/auth/register':
            username = body.get('username', '').strip()
            password = body.get('password', '').strip()
            if not username or not password:
                self._send_json({'ok': False, 'error': '用户名和密码不能为空'}, 400)
                return
            if len(username) < 2 or len(username) > 20:
                self._send_json({'ok': False, 'error': '用户名长度 2-20 个字符'}, 400)
                return
            if len(password) < 4:
                self._send_json({'ok': False, 'error': '密码至少 4 个字符'}, 400)
                return

            with _users_lock:
                users = _load_users()
                if username in users:
                    self._send_json({'ok': False, 'error': '用户名已存在'}, 409)
                    return

                token = secrets.token_hex(32)
                users[username] = {
                    'password': _hash_password(password),
                    'token': token,
                    'api_key': '',
                    'created_at': datetime.now().isoformat(),
                }
                _save_users(users)

            # 初始化用户数据文件（无需锁，首次创建不会有冲突）
            common_path = os.path.join(DATA_DIR, 'vocabulary-data.json')
            template = {'words': [], 'sentences': [], 'mathProblems': [], 'problems': []}
            if os.path.exists(common_path):
                common = _load_json(common_path)
                if isinstance(common, dict):
                    for k in template:
                        if k not in common:
                            common[k] = template[k]
                    _save_json(_get_user_data_file(username), common)
                else:
                    _save_json(_get_user_data_file(username), template)
            else:
                _save_json(_get_user_data_file(username), template)

            self._send_json({'ok': True, 'token': token, 'username': username, 'apiKey': ''})
            return

        elif path == '/api/auth/login':
            username = body.get('username', '').strip()
            password = body.get('password', '').strip()
            if not username or not password:
                self._send_json({'ok': False, 'error': '请输入用户名和密码'}, 400)
                return

            users = _load_users()
            if username not in users:
                self._send_json({'ok': False, 'error': '用户名或密码错误'}, 401)
                return
            if users[username]['password'] != _hash_password(password):
                self._send_json({'ok': False, 'error': '用户名或密码错误'}, 401)
                return

            # 复用已有 token，避免多设备登录互相踢下线
            token = users[username].get('token', '')
            if not token:
                with _users_lock:
                    users = _load_users()
                    token = secrets.token_hex(32)
                    users[username]['token'] = token
                    _save_users(users)

            api_key = users[username].get('api_key', '') or ''
            self._send_json({'ok': True, 'token': token, 'username': username, 'apiKey': api_key})

        elif path == '/api/auth/verify':
            username = self._get_token_user()
            if username:
                users = _load_users()
                api_key = users[username].get('api_key', '') or ''
                self._send_json({'ok': True, 'username': username, 'apiKey': api_key})
            else:
                self._send_json({'ok': False, 'error': 'token 无效'}, 401)

        elif path == '/api/auth/update-key':
            username = self._get_token_user()
            if not username:
                self._send_json({'ok': False, 'error': '未登录'}, 401)
                return
            api_key = body.get('apiKey', '').strip()
            with _users_lock:
                users = _load_users()
                users[username]['api_key'] = api_key
                _save_users(users)
            self._send_json({'ok': True})

        else:
            self._send_json({'ok': False, 'error': '未知路径'}, 404)

    # ---- 单词数据 API（需要登录） ----

    def do_GET(self):
        if self.path.startswith('/api/auth/'):
            return self.do_AUTH()

        if self.path == '/api/words' or self.path.startswith('/api/words?'):
            username = self._get_token_user()
            if not username:
                self._send_json({'ok': False, 'error': '未登录'}, 401)
                return
            data = _read_user_data(username)
            self._send_json(data)
            return

        super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/auth/'):
            return self.do_AUTH()

        if self.path == '/api/words':
            username = self._get_token_user()
            if not username:
                self._send_json({'ok': False, 'error': '未登录'}, 401)
                return

            try:
                length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(length).decode('utf-8')
                incoming = json.loads(body)

                with _get_user_data_lock(username):
                    existing = _read_user_data(username)

                    if isinstance(incoming, dict) and 'words' in incoming:
                        merged_words = _merge_items(existing['words'], incoming.get('words', []), 'word')
                        merged_sentences = _merge_items(existing['sentences'], incoming.get('sentences', []), 'id')
                        merged_math = _merge_items(existing['mathProblems'], incoming.get('mathProblems', []), 'indexTitle', 'title')
                        merged_problems = _merge_items(existing['problems'], incoming.get('problems', []), 'indexTitle', 'question')
                        merged_methods = _merge_items(existing.get('methods', []), incoming.get('methods', []), 'id')
                        result = {'words': merged_words, 'sentences': merged_sentences, 'mathProblems': merged_math, 'problems': merged_problems, 'methods': merged_methods}
                        count = len(merged_words) + len(merged_sentences) + len(merged_math) + len(merged_problems) + len(merged_methods)
                    elif isinstance(incoming, list):
                        merged_words = _merge_items(existing['words'], incoming, 'word')
                        result = merged_words
                        count = len(merged_words)
                    else:
                        raise ValueError('无法识别的数据格式')

                    _save_json(_get_user_data_file(username), result)
                self._send_json({'ok': True, 'count': count, 'merged': True})
            except Exception as e:
                self._send_json({'ok': False, 'error': str(e)}, 500)
            return

        # 兼容旧式无登录 POST（检测到旧客户端时允许，但不推荐）
        if self.path == '/api/words-legacy':
            try:
                length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(length).decode('utf-8')
                data = json.loads(body)
                path = os.path.join(DATA_DIR, 'vocabulary-data.json')
                if isinstance(data, dict) and 'words' in data:
                    _save_json(path, data)
                else:
                    _save_json(path, data)
                self._send_json({'ok': True, 'legacy': True})
            except Exception as e:
                self._send_json({'ok': False, 'error': str(e)}, 500)
            return

        self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def log_message(self, format, *args):
        if '/api/' in str(args):
            return
        super().log_message(format, *args)


if __name__ == '__main__':
    os.chdir(DATA_DIR)
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = '（无法检测，请在电脑上运行 ipconfig 查看）'

    # 统计已注册用户
    users = _load_users()
    user_count = len(users)

    print(f'''
  ╔═══════════════════════════════════════════╗
  ║   艾宾浩斯记忆助手 · 本地服务器              ║
  ║                                           ║
  ║   本机访问: http://localhost:{PORT}          ║
  ║   手机访问: http://{local_ip}:{PORT}          ║
  ║                                           ║
  ║   已注册用户: {user_count} 人                    ║
  ║
  ║   首次使用请先注册账号                      ║
  ║   每个用户数据独立存储                      ║
  ║
  ║   手机访问步骤：                           ║
  ║   1. 手机连接同一 WiFi                    ║
  ║   2. 打开手机 Chrome 浏览器               ║
  ║   3. 输入上方「手机访问」地址              ║
  ║   4. 注册账号后添加到主屏幕                ║
  ║                                           ║
  ║   按 Ctrl+C 停止服务器                     ║
  ╚═══════════════════════════════════════════╝
    ''')

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n服务器已停止')
        server.server_close()
        sys.exit(0)
