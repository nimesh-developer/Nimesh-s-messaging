import os
import sys
import socket
import time
import datetime
import uuid
import re
import random
import argparse
from flask import Flask, jsonify, request, send_from_directory, send_file
from flask_cors import CORS
from werkzeug.utils import secure_filename
from werkzeug.serving import run_simple
import socketio

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, 'public')
UPLOADS_DIR = os.path.join(BASE_DIR, 'uploads')
server_start_time = time.time()

if not os.path.exists(UPLOADS_DIR):
    os.makedirs(UPLOADS_DIR, exist_ok=True)

app = Flask(__name__, static_folder=PUBLIC_DIR, static_url_path='')
CORS(app)

sio = socketio.Server(
    cors_allowed_origins='*',
    max_http_buffer_size=100 * 1024 * 1024, # 100 MB
    async_mode='threading'
)

class SocketIOWSGIApp:
    def __init__(self, sio, flask_app):
        self.sio_app = socketio.WSGIApp(sio, flask_app)
        self.flask_app = flask_app

    def __call__(self, environ, start_response):
        path = environ.get('PATH_INFO', '')
        if path in ['/socket.io/socket.io.js', '/socket.io.js']:
            return self.flask_app(environ, start_response)
        return self.sio_app(environ, start_response)

wsgi_app = SocketIOWSGIApp(sio, app)

import json
import hashlib

USERS_FILE = os.path.join(BASE_DIR, 'users.json')

# Persistent user accounts database: username_lower -> account_dict
accounts_db = {}
banned_lan_ids = set()
banned_ips = set()
audit_logs = []
lan_id_counter = 1

def log_audit(action, target, details=""):
    entry = {
        'id': f"audit_{int(time.time() * 1000)}",
        'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'action': action,
        'target': target,
        'details': details
    }
    audit_logs.append(entry)
    if len(audit_logs) > 200:
        audit_logs.pop(0)
    save_users()

def hash_password(password, salt="lan_chat_salt_2026"):
    return hashlib.sha256(f"{salt}:{password}".encode('utf-8')).hexdigest()

def load_users():
    global lan_id_counter, accounts_db, active_groups, room_messages, banned_lan_ids, banned_ips, audit_logs
    if os.path.exists(USERS_FILE):
        try:
            with open(USERS_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                accounts_db = data.get('users', {})
                lan_id_counter = data.get('lanIdCounter', 1)
                active_groups = data.get('groups', {})
                room_messages = data.get('messages', {})
                banned_lan_ids = set(data.get('bannedLanIds', []))
                banned_ips = set(data.get('bannedIps', []))
                audit_logs = data.get('auditLogs', [])
        except Exception as e:
            print(f"Error loading users file: {e}")

def save_users():
    try:
        data = {
            'lanIdCounter': lan_id_counter,
            'users': accounts_db,
            'groups': active_groups,
            'messages': room_messages,
            'bannedLanIds': list(banned_lan_ids),
            'bannedIps': list(banned_ips),
            'auditLogs': audit_logs
        }
        with open(USERS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"Error saving users file: {e}")

load_users()

# Live user state management
users_by_socket = {}  # socket_id -> User dict
users_by_lan_id = {}  # lan_id -> User dict
room_messages = {}    # room_id -> list of message dicts
active_groups = {}    # group_id -> group dict

AVATAR_COLORS = [
    '#3b82f6', '#10b981', '#8b5cf6', '#ec4899',
    '#f59e0b', '#06b6d4', '#6366f1', '#14b8a6'
]

def format_lan_id(num):
    return f"LAN{num:04d}"

def get_lan_ips():
    ips = []
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith('127.'):
                ips.append(ip)
    except Exception:
        pass

    if not ips:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(('8.8.8.8', 80))
            ip = s.getsockname()[0]
            s.close()
            if ip and not ip.startswith('127.'):
                ips.append(ip)
        except Exception:
            pass

    return list(dict.fromkeys(ips))

def register_account(username, password, requested_lan_id=None):
    global lan_id_counter
    username_clean = username.strip()[:24]
    key = username_clean.lower()

    if not username_clean:
        return None, "Username cannot be empty."
    if not password:
        return None, "Password cannot be empty."
    if key in accounts_db:
        return None, "Username already exists. Please login."

    lan_id = requested_lan_id
    if lan_id:
        lan_id = str(lan_id).strip().upper()

    existing_lan_ids = {acc['lanId'] for acc in accounts_db.values()}
    if (not lan_id or
        not re.match(r'^LAN\d{4}$', lan_id) or
        lan_id in existing_lan_ids):
        while format_lan_id(lan_id_counter) in existing_lan_ids:
            lan_id_counter += 1
        lan_id = format_lan_id(lan_id_counter)
        lan_id_counter += 1

    try:
        num = int(lan_id.replace('LAN', ''))
    except ValueError:
        num = 0
    color_index = num % len(AVATAR_COLORS)

    account = {
        'username': username_clean,
        'passwordHash': hash_password(password),
        'lanId': lan_id,
        'color': AVATAR_COLORS[color_index],
        'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat()
    }

    accounts_db[key] = account
    save_users()

    return account, None

def authenticate_account(username, password):
    if not username or not password:
        return None, "Username and password required."

    key = username.strip().lower()
    account = accounts_db.get(key)
    if not account:
        return None, "Account not found. Please register."

    if account['passwordHash'] != hash_password(password):
        return None, "Incorrect password."

    return account, None

def bind_user_session(socket_id, account):
    lan_id = account['lanId']
    user = {
        'socketId': socket_id,
        'lanId': lan_id,
        'username': account['username'],
        'color': account['color'],
        'online': True,
        'joinedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()
    }

    users_by_socket[socket_id] = user
    users_by_lan_id[lan_id] = user

    return user

def get_message_history(room_id):
    if room_id not in room_messages:
        room_messages[room_id] = []
    return room_messages[room_id]

def save_message(room_id, msg):
    history = get_message_history(room_id)
    history.append(msg)
    if len(history) > 500:
        history.pop(0)
    save_users()

def is_localhost_request():
    remote = request.remote_addr or ''
    host = request.headers.get('Host', '')
    if remote in ('127.0.0.1', '::1', 'localhost') or remote.endswith('127.0.0.1'):
        return True
    if host.startswith('localhost') or host.startswith('127.0.0.1'):
        return True
    return False

def is_localhost_sid(sid):
    try:
        environ = sio.get_environ(sid)
        if environ:
            remote = environ.get('REMOTE_ADDR', '')
            host = environ.get('HTTP_HOST', '')
            if remote in ('127.0.0.1', '::1', 'localhost') or remote.endswith('127.0.0.1'):
                return True
            if host.startswith('localhost') or host.startswith('127.0.0.1'):
                return True
    except Exception:
        pass
    return False

# REST API Endpoints
@app.route('/api/admin/state', methods=['GET'])
def admin_get_state():
    if not is_localhost_request():
        return jsonify({'error': 'Admin actions allowed only on localhost'}), 403

    active_sockets_info = []
    for sid, u in users_by_socket.items():
        active_sockets_info.append({
            'socketId': sid,
            'lanId': u.get('lanId'),
            'username': u.get('username'),
            'online': u.get('online', True)
        })

    return jsonify({
        'users': accounts_db,
        'groups': active_groups,
        'messages': room_messages,
        'bannedLanIds': list(banned_lan_ids),
        'bannedIps': list(banned_ips),
        'auditLogs': audit_logs,
        'activeSockets': active_sockets_info,
        'health': {
            'activeConnections': len(users_by_socket),
            'registeredUsers': len(accounts_db),
            'totalGroups': len(active_groups),
            'totalRoomsWithMessages': len(room_messages),
            'serverUptimeSeconds': int(time.time() - server_start_time)
        }
    })

@app.route('/api/admin/broadcast', methods=['POST'])
def admin_broadcast():
    if not is_localhost_request():
        return jsonify({'error': 'Admin actions allowed only on localhost'}), 403

    payload = request.get_json(silent=True) or {}
    message_text = str(payload.get('message', '')).strip()

    if not message_text:
        return jsonify({'error': 'Broadcast message cannot be empty'}), 400

    sys_msg = {
        'id': f"sys_announcement_{int(time.time() * 1000)}",
        'roomId': 'general',
        'sender': {'lanId': 'ADMIN', 'username': '📢 SERVER ANNOUNCEMENT', 'color': '#ef4444'},
        'content': message_text,
        'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'isSystem': True
    }
    save_message('general', sys_msg)
    sio.emit('new_message', sys_msg, room='general')
    log_audit('broadcast', 'GLOBAL', message_text)

    return jsonify({'success': True, 'message': 'Announcement broadcasted to all users.'})

@app.route('/api/admin/ban', methods=['POST'])
def admin_ban():
    if not is_localhost_request():
        return jsonify({'error': 'Admin actions allowed only on localhost'}), 403

    payload = request.get_json(silent=True) or {}
    lan_id = str(payload.get('lanId', '')).strip().upper()
    ip_addr = str(payload.get('ip', '')).strip()

    if lan_id:
        banned_lan_ids.add(lan_id)
        # Disconnect sockets matching banned LAN ID
        for sid, u in list(users_by_socket.items()):
            if u.get('lanId') == lan_id:
                sio.emit('user_banned', {'reason': f"LAN ID {lan_id} has been banned by Localhost Admin."}, room=sid)

    if ip_addr:
        banned_ips.add(ip_addr)

    save_users()
    sio.emit('users_list', list(users_by_lan_id.values()))
    return jsonify({'success': True, 'message': f"Banned LAN ID: {lan_id}, IP: {ip_addr}"})

@app.route('/api/admin/unban', methods=['POST'])
def admin_unban():
    if not is_localhost_request():
        return jsonify({'error': 'Admin actions allowed only on localhost'}), 403

    payload = request.get_json(silent=True) or {}
    lan_id = str(payload.get('lanId', '')).strip().upper()
    ip_addr = str(payload.get('ip', '')).strip()

    if lan_id in banned_lan_ids:
        banned_lan_ids.remove(lan_id)
    if ip_addr in banned_ips:
        banned_ips.remove(ip_addr)

    save_users()
    return jsonify({'success': True, 'message': f"Unbanned LAN ID: {lan_id}, IP: {ip_addr}"})

@app.route('/api/admin/edit-user', methods=['POST'])
def admin_edit_user():
    if not is_localhost_request():
        return jsonify({'error': 'Admin actions allowed only on localhost'}), 403

    payload = request.get_json(silent=True) or {}
    target_lan_id = str(payload.get('targetLanId', '')).strip().upper()

    if not target_lan_id:
        return jsonify({'error': 'Target LAN ID is required'}), 400

    acc, err = update_account_profile(
        target_lan_id,
        new_username=payload.get('username'),
        new_lan_id=payload.get('lanId'),
        new_password=payload.get('password'),
        new_color=payload.get('color')
    )

    if err:
        return jsonify({'error': err}), 400

    return jsonify({'success': True, 'account': acc})

@app.route('/api/admin/delete-user', methods=['POST'])
def admin_delete_user():
    if not is_localhost_request():
        return jsonify({'error': 'Admin actions allowed only on localhost'}), 403

    payload = request.get_json(silent=True) or {}
    target_lan_id = str(payload.get('targetLanId', '')).strip().upper()

    account_key = None
    for k, acc in accounts_db.items():
        if acc.get('lanId') == target_lan_id:
            account_key = k
            break

    if account_key:
        del accounts_db[account_key]

    if target_lan_id in users_by_lan_id:
        del users_by_lan_id[target_lan_id]

    for sid, u in list(users_by_socket.items()):
        if u.get('lanId') == target_lan_id:
            sio.emit('user_banned', {'reason': 'Your account was deleted by Localhost Admin.'}, room=sid)
            del users_by_socket[sid]

    save_users()
    sio.emit('users_list', list(users_by_lan_id.values()))
    return jsonify({'success': True, 'message': f"Account {target_lan_id} deleted."})

@app.route('/api/admin/delete-message', methods=['POST'])
def admin_delete_message():
    if not is_localhost_request():
        return jsonify({'error': 'Admin actions allowed only on localhost'}), 403

    payload = request.get_json(silent=True) or {}
    room_id = payload.get('roomId')
    msg_id = payload.get('messageId')

    if not room_id or not msg_id:
        return jsonify({'error': 'Room ID and Message ID required'}), 400

    history = get_message_history(room_id)
    msg_idx = next((i for i, m in enumerate(history) if m['id'] == msg_id), None)
    if msg_idx is not None:
        history.pop(msg_idx)
        save_users()
        sio.emit('message_deleted', {'roomId': room_id, 'messageId': msg_id}, room=room_id)
        return jsonify({'success': True})

    return jsonify({'error': 'Message not found'}), 404

@app.route('/api/admin/reset', methods=['POST'])
def admin_reset():
    if not is_localhost_request():
        return jsonify({'error': 'Admin actions allowed only on localhost'}), 403

    global accounts_db, lan_id_counter, room_messages, active_groups, users_by_socket, users_by_lan_id, banned_lan_ids, banned_ips
    accounts_db.clear()
    banned_lan_ids.clear()
    banned_ips.clear()
    lan_id_counter = 1
    room_messages.clear()
    active_groups.clear()
    users_by_socket.clear()
    users_by_lan_id.clear()

    save_users()
    sio.emit('server_reset', {})
    sio.emit('users_list', [])

    return jsonify({'success': True, 'message': 'All accounts, chats, and groups have been reset.'})

@app.route('/api/admin/export', methods=['GET'])
def admin_export():
    if not is_localhost_request():
        return jsonify({'error': 'Admin actions allowed only on localhost'}), 403

    data = {
        'lanIdCounter': lan_id_counter,
        'users': accounts_db,
        'groups': active_groups,
        'messages': room_messages,
        'bannedLanIds': list(banned_lan_ids),
        'bannedIps': list(banned_ips)
    }
    response = app.response_class(
        response=json.dumps(data, indent=2),
        status=200,
        mimetype='application/json'
    )
    response.headers["Content-Disposition"] = "attachment; filename=lan_chat_backup.json"
    return response

@app.route('/api/admin/import', methods=['POST'])
def admin_import():
    if not is_localhost_request():
        return jsonify({'error': 'Admin actions allowed only on localhost'}), 403

    global accounts_db, lan_id_counter, room_messages, active_groups, banned_lan_ids, banned_ips
    data = None
    if 'file' in request.files:
        file = request.files['file']
        try:
            data = json.load(file)
        except Exception as e:
            return jsonify({'error': f'Invalid JSON file: {e}'}), 400
    else:
        data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({'error': 'Invalid backup data payload'}), 400

    accounts_db = data.get('users', {})
    lan_id_counter = data.get('lanIdCounter', 1)
    active_groups = data.get('groups', {})
    room_messages = data.get('messages', {})
    banned_lan_ids = set(data.get('bannedLanIds', []))
    banned_ips = set(data.get('bannedIps', []))

    save_users()

    # Refresh socket user state if accounts changed
    for sid, u in list(users_by_socket.items()):
        matching = next((acc for acc in accounts_db.values() if acc['lanId'] == u['lanId']), None)
        if matching:
            u['username'] = matching['username']
            u['color'] = matching['color']
        else:
            # Account no longer exists after import
            pass

    sio.emit('data_imported', {})
    sio.emit('users_list', list(users_by_lan_id.values()))

    return jsonify({'success': True, 'message': 'Data imported successfully.'})

@app.route('/api/lan-info', methods=['GET'])
def get_lan_info():
    port = app.config.get('PORT', 3000)
    ips = get_lan_ips()
    return jsonify({
        'port': port,
        'ips': ips if ips else ['127.0.0.1'],
        'primaryIp': ips[0] if ips else '127.0.0.1'
    })

@app.route('/api/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400

    file = request.files['file']
    if not file or file.filename == '':
        return jsonify({'error': 'No file uploaded'}), 400

    orig_name = file.filename
    sec_filename = secure_filename(orig_name)
    ext = os.path.splitext(sec_filename)[1]
    if not ext:
        ext = os.path.splitext(orig_name)[1]

    unique_filename = f"{int(time.time() * 1000)}-{random.randint(1, 1000000000)}{ext}"
    file_path = os.path.join(UPLOADS_DIR, unique_filename)
    file.save(file_path)

    size = os.path.getsize(file_path)
    mime = file.mimetype or ''

    file_info = {
        'originalName': orig_name,
        'filename': unique_filename,
        'size': size,
        'mimeType': mime,
        'url': f"/uploads/{unique_filename}",
        'downloadUrl': f"/download/{unique_filename}",
        'isImage': mime.startswith('image/'),
        'isVideo': mime.startswith('video/'),
        'isAudio': mime.startswith('audio/')
    }

    return jsonify({'success': True, 'file': file_info})

@app.route('/download/<path:filename>', methods=['GET'])
def download_file(filename):
    file_path = os.path.join(UPLOADS_DIR, filename)
    if not os.path.exists(file_path):
        return 'File not found', 404

    original_name = request.args.get('name', filename)
    return send_file(file_path, as_attachment=True, download_name=original_name)

@app.route('/uploads/<path:filename>', methods=['GET'])
def serve_uploads(filename):
    return send_from_directory(UPLOADS_DIR, filename)

@app.route('/socket.io/socket.io.js', methods=['GET'])
@app.route('/socket.io.js', methods=['GET'])
def serve_socketio_js():
    candidates = [
        os.path.join(PUBLIC_DIR, 'socket.io', 'socket.io.js'),
        os.path.join(PUBLIC_DIR, 'socket.io.js'),
        os.path.join(BASE_DIR, 'node_modules', 'socket.io-client', 'dist', 'socket.io.js')
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return send_file(candidate, mimetype='application/javascript')
    return "Socket.IO client JS file not found", 404

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_static(path):
    if path != '' and os.path.exists(os.path.join(PUBLIC_DIR, path)):
        return send_from_directory(PUBLIC_DIR, path)
    return send_from_directory(PUBLIC_DIR, 'index.html')

# Socket.IO Event Handlers
@sio.event
def connect(sid, environ):
    client_ip = environ.get('REMOTE_ADDR', '')
    if client_ip in banned_ips:
        sio.emit('user_banned', {'reason': f"Your IP ({client_ip}) has been banned by Localhost Admin."}, room=sid)
        return False
    print(f"Socket connected: {sid}")

@sio.event
def user_register(sid, data=None):
    if data is None:
        data = {}
    lan_id = data.get('lanId')
    if lan_id and str(lan_id).strip().upper() in banned_lan_ids:
        return {'success': False, 'error': f"LAN ID {lan_id} is banned."}
    if data is None:
        data = {}
    username = data.get('username', '')
    password = data.get('password', '')
    lan_id = data.get('lanId')

    account, error = register_account(username, password, lan_id)
    if error:
        return {'success': False, 'error': error}

    user = bind_user_session(sid, account)
    sio.enter_room(sid, 'general')

    sio.emit('users_list', list(users_by_lan_id.values()))

    sys_msg = {
        'id': f"sys_{int(time.time() * 1000)}_{uuid.uuid4().hex[:5]}",
        'roomId': 'general',
        'sender': {'lanId': 'SYSTEM', 'username': 'System', 'color': '#64748b'},
        'content': f"{user['username']} ({user['lanId']}) registered & connected to LAN Chat.",
        'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'isSystem': True
    }
    save_message('general', sys_msg)
    sio.emit('new_message', sys_msg, room='general')

    user_groups = [g for g in active_groups.values() if user['lanId'] in g['members']]
    return {
        'success': True,
        'user': user,
        'groups': user_groups
    }

@sio.event
def user_login(sid, data=None):
    if data is None:
        data = {}
    username = data.get('username', '')
    password = data.get('password', '')

    account, error = authenticate_account(username, password)
    if error:
        return {'success': False, 'error': error}

    if account['lanId'] in banned_lan_ids:
        return {'success': False, 'error': f"LAN ID {account['lanId']} is banned from accessing LAN Chat."}

    user = bind_user_session(sid, account)
    sio.enter_room(sid, 'general')

    sio.emit('users_list', list(users_by_lan_id.values()))

    sys_msg = {
        'id': f"sys_{int(time.time() * 1000)}_{uuid.uuid4().hex[:5]}",
        'roomId': 'general',
        'sender': {'lanId': 'SYSTEM', 'username': 'System', 'color': '#64748b'},
        'content': f"{user['username']} ({user['lanId']}) logged in to LAN Chat.",
        'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'isSystem': True
    }
    save_message('general', sys_msg)
    sio.emit('new_message', sys_msg, room='general')

    user_groups = [g for g in active_groups.values() if user['lanId'] in g['members']]
    return {
        'success': True,
        'user': user,
        'groups': user_groups
    }

@sio.event
def user_join(sid, data=None):
    if data is None:
        data = {}
    username = data.get('username', '')
    password = data.get('password', '')

    # Try authenticate first
    account, err = authenticate_account(username, password)
    if not account:
        # If no account exists and password provided, try registering
        if password:
            account, err = register_account(username, password, data.get('lanId'))

    if not account:
        # Fallback for unauthenticated legacy test or auto guest user if no password
        key = username.strip().lower() if username else ''
        if key in accounts_db:
            account = accounts_db[key]
        else:
            account, _ = register_account(username or f"User_{sid[:4]}", password or "guest_pass", data.get('lanId'))

    user = bind_user_session(sid, account)
    sio.enter_room(sid, 'general')

    sio.emit('users_list', list(users_by_lan_id.values()))

    sys_msg = {
        'id': f"sys_{int(time.time() * 1000)}_{uuid.uuid4().hex[:5]}",
        'roomId': 'general',
        'sender': {'lanId': 'SYSTEM', 'username': 'System', 'color': '#64748b'},
        'content': f"{user['username']} ({user['lanId']}) connected to LAN Chat.",
        'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'isSystem': True
    }
    save_message('general', sys_msg)
    sio.emit('new_message', sys_msg, room='general')

    user_groups = [g for g in active_groups.values() if user['lanId'] in g['members']]
    return {
        'success': True,
        'user': user,
        'groups': user_groups
    }

def update_account_profile(target_lan_id, new_username=None, new_lan_id=None, new_password=None, new_color=None):
    # Find account in accounts_db
    account_key = None
    account = None
    for k, acc in accounts_db.items():
        if acc.get('lanId') == target_lan_id:
            account_key = k
            account = acc
            break

    if not account:
        return None, "Account not found"

    old_username = account['username']
    old_lan_id = account['lanId']

    # Validate new username
    if new_username is not None:
        clean_name = str(new_username).strip()[:24]
        if not clean_name:
            return None, "Username cannot be empty"
        new_key = clean_name.lower()
        if new_key != account_key and new_key in accounts_db:
            return None, "Username already in use by another account"
        
        # If key changes in accounts_db
        if new_key != account_key:
            del accounts_db[account_key]
            accounts_db[new_key] = account
            account_key = new_key
        account['username'] = clean_name

    # Validate new LAN ID
    if new_lan_id is not None:
        clean_lan_id = str(new_lan_id).strip().upper()
        if not re.match(r'^LAN\d{4}$', clean_lan_id):
            return None, "LAN ID must follow the format LANXXXX (e.g. LAN0001)"
        
        existing_lan_owner = next((acc for acc in accounts_db.values() if acc['lanId'] == clean_lan_id and acc is not account), None)
        if existing_lan_owner:
            return None, f"LAN ID {clean_lan_id} is already assigned to another account"

        if clean_lan_id != old_lan_id:
            account['lanId'] = clean_lan_id

            # Update active groups containing old_lan_id
            for grp_id, grp in active_groups.items():
                if grp.get('createdBy') == old_lan_id:
                    grp['createdBy'] = clean_lan_id
                if 'admins' in grp and old_lan_id in grp['admins']:
                    grp['admins'] = [clean_lan_id if x == old_lan_id else x for x in grp['admins']]
                if 'members' in grp and old_lan_id in grp['members']:
                    grp['members'] = [clean_lan_id if x == old_lan_id else x for x in grp['members']]

            # Update live session maps
            if old_lan_id in users_by_lan_id:
                user_obj = users_by_lan_id.pop(old_lan_id)
                user_obj['lanId'] = clean_lan_id
                users_by_lan_id[clean_lan_id] = user_obj

    if new_password:
        if len(new_password) < 3:
            return None, "Password too short"
        account['passwordHash'] = hash_password(new_password)

    if new_color:
        account['color'] = new_color

    # Update active socket user objects matching target_lan_id
    current_lan_id = account['lanId']
    if current_lan_id in users_by_lan_id:
        users_by_lan_id[current_lan_id]['username'] = account['username']
        users_by_lan_id[current_lan_id]['color'] = account['color']

    for u in users_by_socket.values():
        if u['lanId'] == old_lan_id or u['lanId'] == current_lan_id:
            u['lanId'] = current_lan_id
            u['username'] = account['username']
            u['color'] = account['color']

    save_users()

    sio.emit('users_list', list(users_by_lan_id.values()))
    sio.emit('profile_updated', {
        'oldLanId': old_lan_id,
        'account': {
            'username': account['username'],
            'lanId': account['lanId'],
            'color': account['color']
        }
    })

    return account, None

@sio.event
def set_custom_status(sid, data=None):
    if data is None:
        data = {}
    user = users_by_socket.get(sid)
    if not user:
        return {'success': False, 'error': 'User not found'}

    status_text = str(data.get('status', '')).strip()[:40]
    user['customStatus'] = status_text
    users_by_lan_id[user['lanId']]['customStatus'] = status_text

    for acc in accounts_db.values():
        if acc.get('lanId') == user['lanId']:
            acc['customStatus'] = status_text
            break

    save_users()
    sio.emit('users_list', list(users_by_lan_id.values()))
    return {'success': True, 'customStatus': status_text}

@sio.event
def join_group_by_code(sid, data=None):
    if data is None:
        data = {}
    user = users_by_socket.get(sid)
    if not user:
        return {'success': False, 'error': 'User not found'}

    code = str(data.get('code', '')).strip().upper()
    grp = next((g for g in active_groups.values() if g.get('joinCode') == code), None)

    if not grp:
        return {'success': False, 'error': 'Invalid group invite code.'}

    if user['lanId'] not in grp['members']:
        grp['members'].append(user['lanId'])
        save_users()

    sio.enter_room(sid, grp['id'])
    sio.emit('group_added', grp, room=sid)
    sio.emit('group_updated', grp, room=grp['id'])

    return {'success': True, 'group': grp}

@sio.event
def update_profile(sid, data=None):
    if data is None:
        data = {}
    user = users_by_socket.get(sid)
    if not user:
        return {'success': False, 'error': 'User not found'}

    new_username = data.get('username')
    new_lan_id = data.get('lanId')
    new_password = data.get('password')
    new_color = data.get('color')

    acc, err = update_account_profile(
        user['lanId'],
        new_username=new_username,
        new_lan_id=new_lan_id,
        new_password=new_password,
        new_color=new_color
    )

    if err:
        return {'success': False, 'error': err}

    updated_user = users_by_socket.get(sid)
    return {'success': True, 'user': updated_user}

@sio.event
def get_history(sid, room_id):
    if is_localhost_sid(sid) and room_id.startswith('group_'):
        sio.enter_room(sid, room_id)
    return get_message_history(room_id)

@sio.event
def create_group(sid, data=None):
    if data is None:
        data = {}
    current_user = users_by_socket.get(sid)
    if not current_user:
        return {'success': False, 'error': 'User not found'}

    raw_input = data.get('lanIdsInput', '')
    if isinstance(raw_input, list):
        parsed_ids = [str(s).strip().upper() for s in raw_input if re.match(r'^LAN\d{4}$', str(s).strip().upper())]
    else:
        parsed_ids = [s.strip().upper() for s in str(raw_input).split(',') if re.match(r'^LAN\d{4}$', s.strip().upper())]

    if current_user['lanId'] not in parsed_ids:
        parsed_ids.append(current_user['lanId'])

    unique_members = sorted(list(dict.fromkeys(parsed_ids)))

    if len(unique_members) < 2:
        return {'success': False, 'error': 'Please select at least one other valid LAN ID.'}

    group_id = f"group_{int(time.time() * 1000)}_{uuid.uuid4().hex[:4]}"
    group_name = data.get('groupName', '').strip() or f"Group ({len(unique_members)} members)"

    group_obj = {
        'id': group_id,
        'name': group_name,
        'members': unique_members,
        'createdBy': current_user['lanId'],
        'admins': [current_user['lanId']],
        'disallowedFileTypes': data.get('disallowedFileTypes', []),
        'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat()
    }

    active_groups[group_id] = group_obj
    save_users()

    for lan_id in unique_members:
        member_user = users_by_lan_id.get(lan_id)
        if member_user and member_user.get('socketId'):
            member_sid = member_user['socketId']
            sio.enter_room(member_sid, group_id)
            sio.emit('group_added', group_obj, room=member_sid)

    return {'success': True, 'group': group_obj}

@sio.event
def manage_group(sid, data=None):
    if data is None:
        data = {}
    user = users_by_socket.get(sid)
    if not user:
        return {'success': False, 'error': 'User not found'}

    group_id = data.get('groupId')
    action = data.get('action')
    group = active_groups.get(group_id)

    if not group:
        return {'success': False, 'error': 'Group not found'}

    is_owner = (group.get('createdBy') == user['lanId'])
    is_admin = is_owner or (user['lanId'] in group.get('admins', []))

    if not is_admin:
        return {'success': False, 'error': 'Permission denied: Group Admin or Owner required.'}

    if action == 'rename':
        new_name = str(data.get('name', '')).strip()[:40]
        if not new_name:
            return {'success': False, 'error': 'Group name cannot be empty'}
        group['name'] = new_name

    elif action == 'add_members':
        new_ids = data.get('lanIds', [])
        if isinstance(new_ids, str):
            new_ids = [s.strip().upper() for s in new_ids.split(',') if re.match(r'^LAN\d{4}$', s.strip().upper())]

        added = []
        for lid in new_ids:
            lid_clean = lid.strip().upper()
            if re.match(r'^LAN\d{4}$', lid_clean) and lid_clean not in group['members']:
                group['members'].append(lid_clean)
                added.append(lid_clean)

                target_user = users_by_lan_id.get(lid_clean)
                if target_user and target_user.get('socketId'):
                    sio.enter_room(target_user['socketId'], group_id)
                    sio.emit('group_added', group, room=target_user['socketId'])

    elif action == 'remove_member':
        target_lan_id = str(data.get('targetLanId', '')).strip().upper()
        if target_lan_id == group.get('createdBy') and not is_owner:
            return {'success': False, 'error': 'Cannot remove group owner'}
        
        if target_lan_id in group['members']:
            group['members'].remove(target_lan_id)
            if 'admins' in group and target_lan_id in group['admins']:
                group['admins'].remove(target_lan_id)

            target_user = users_by_lan_id.get(target_lan_id)
            if target_user and target_user.get('socketId'):
                sio.leave_room(target_user['socketId'], group_id)
                sio.emit('group_removed', {'groupId': group_id}, room=target_user['socketId'])

    elif action == 'grant_admin':
        if not is_owner:
            return {'success': False, 'error': 'Only Group Owner can grant Admin powers'}
        target_lan_id = str(data.get('targetLanId', '')).strip().upper()
        if 'admins' not in group:
            group['admins'] = [group['createdBy']]
        if target_lan_id in group['members'] and target_lan_id not in group['admins']:
            group['admins'].append(target_lan_id)

    elif action == 'revoke_admin':
        if not is_owner:
            return {'success': False, 'error': 'Only Group Owner can revoke Admin powers'}
        target_lan_id = str(data.get('targetLanId', '')).strip().upper()
        if target_lan_id == group.get('createdBy'):
            return {'success': False, 'error': 'Cannot revoke Owner admin rights'}
        if 'admins' in group and target_lan_id in group['admins']:
            group['admins'].remove(target_lan_id)

    elif action == 'transfer_ownership':
        if not is_owner:
            return {'success': False, 'error': 'Only Group Owner can transfer ownership'}
        target_lan_id = str(data.get('targetLanId', '')).strip().upper()
        if target_lan_id in group['members']:
            group['createdBy'] = target_lan_id
            if 'admins' not in group:
                group['admins'] = []
            if target_lan_id not in group['admins']:
                group['admins'].append(target_lan_id)

    elif action == 'update_restrictions':
        disallowed = data.get('disallowedFileTypes', [])
        if isinstance(disallowed, str):
            disallowed = [s.strip().lower() for s in disallowed.split(',') if s.strip()]
        group['disallowedFileTypes'] = [str(s).strip().lower() for s in disallowed if str(s).strip()]

    elif action == 'delete_group':
        if not is_owner:
            return {'success': False, 'error': 'Only Group Owner can delete the group'}
        del active_groups[group_id]
        save_users()
        sio.emit('group_deleted', {'groupId': group_id}, room=group_id)
        return {'success': True}

    save_users()
    sio.emit('group_updated', group, room=group_id)
    return {'success': True, 'group': group}

@sio.event
def edit_message(sid, data=None):
    if data is None:
        data = {}
    user = users_by_socket.get(sid)
    is_admin = is_localhost_sid(sid)

    if not user and not is_admin:
        return {'success': False, 'error': 'User not found'}

    room_id = data.get('roomId')
    msg_id = data.get('messageId')
    new_content = str(data.get('content', '')).strip()

    if not room_id or not msg_id or not new_content:
        return {'success': False, 'error': 'Room ID, Message ID, and new content required'}

    history = get_message_history(room_id)
    msg = next((m for m in history if m['id'] == msg_id), None)
    if not msg:
        return {'success': False, 'error': 'Message not found'}

    is_sender = user and (msg.get('sender', {}).get('lanId') == user['lanId'])
    if not is_sender and not is_admin:
        return {'success': False, 'error': 'Permission denied: Cannot edit another user\'s message'}

    msg['content'] = new_content
    msg['isEdited'] = True
    save_users()

    sio.emit('message_edited', {'roomId': room_id, 'messageId': msg_id, 'content': new_content}, room=room_id)
    return {'success': True, 'message': msg}

@sio.event
def toggle_pin_message(sid, data=None):
    if data is None:
        data = {}
    user = users_by_socket.get(sid)
    is_admin = is_localhost_sid(sid)

    room_id = data.get('roomId')
    msg_id = data.get('messageId')

    if not room_id or not msg_id:
        return {'success': False, 'error': 'Room ID and Message ID required'}

    history = get_message_history(room_id)
    msg = next((m for m in history if m.get('id') == msg_id), None)

    if not msg:
        return {'success': False, 'error': 'Message not found'}

    msg['isPinned'] = not msg.get('isPinned', False)
    save_users()

    sio.emit('message_pinned_toggled', {'roomId': room_id, 'messageId': msg_id, 'isPinned': msg['isPinned']}, room=room_id)
    return {'success': True, 'isPinned': msg['isPinned']}

@sio.event
def delete_message(sid, data=None):
    if data is None:
        data = {}
    user = users_by_socket.get(sid)
    is_admin = is_localhost_sid(sid)

    if not user and not is_admin:
        return {'success': False, 'error': 'User not found'}

    room_id = data.get('roomId')
    msg_id = data.get('messageId')

    if not room_id or not msg_id:
        return {'success': False, 'error': 'Room and Message ID required'}

    history = get_message_history(room_id)
    msg_idx = next((i for i, m in enumerate(history) if m['id'] == msg_id), None)
    if msg_idx is None:
        return {'success': False, 'error': 'Message not found'}

    msg = history[msg_idx]
    is_sender = user and (msg.get('sender', {}).get('lanId') == user['lanId'])
    
    can_delete = is_sender or is_admin
    if not can_delete and room_id.startswith('group_') and room_id in active_groups and user:
        grp = active_groups[room_id]
        if user['lanId'] == grp.get('createdBy') or user['lanId'] in grp.get('admins', []):
            can_delete = True

    if not can_delete:
        return {'success': False, 'error': 'Permission denied: You cannot delete this message'}

    history.pop(msg_idx)
    save_users()

    sio.emit('message_deleted', {'roomId': room_id, 'messageId': msg_id}, room=room_id)
    log_audit('message_delete', user['lanId'] if user else 'LOCALHOST_ADMIN', f"Deleted msg {msg_id} in {room_id}")
    return {'success': True}

@sio.event
def send_message(sid, data=None):
    if data is None:
        data = {}
    user = users_by_socket.get(sid)
    if not user:
        return {'success': False, 'error': 'User not found'}

    room_id = data.get('roomId')
    content = data.get('content')
    attachment = data.get('attachment')

    if not room_id or (not content and not attachment):
        return {'success': False, 'error': 'Empty message'}

    role_tag = None
    if room_id.startswith('group_') and room_id in active_groups:
        grp = active_groups[room_id]
        if user['lanId'] == grp.get('createdBy'):
            role_tag = 'Owner'
        elif user['lanId'] in grp.get('admins', []):
            role_tag = 'Admin'

        if attachment:
            disallowed = grp.get('disallowedFileTypes', [])
            if disallowed:
                filename = (attachment.get('originalName') or attachment.get('filename') or '').lower()
                mime = (attachment.get('mimeType') or '').lower()
                for dt in disallowed:
                    dt_clean = dt.strip().lower()
                    if dt_clean and (filename.endswith(dt_clean) or dt_clean in mime):
                        return {'success': False, 'error': f"File type '{dt_clean}' is restricted in this group by Owner/Admin."}

    msg = {
        'id': f"msg_{int(time.time() * 1000)}_{uuid.uuid4().hex[:5]}",
        'roomId': room_id,
        'sender': {
            'lanId': user['lanId'],
            'username': user['username'],
            'color': user['color'],
            'roleTag': role_tag
        },
        'content': content or '',
        'attachment': attachment,
        'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'reactions': {}
    }

    save_message(room_id, msg)

    if room_id.startswith('dm:'):
        parts = room_id.replace('dm:', '').split('_')
        for lan_id in parts:
            target_user = users_by_lan_id.get(lan_id)
            if target_user and target_user.get('socketId'):
                sio.enter_room(target_user['socketId'], room_id)
        sio.emit('new_message', msg, room=room_id)
    else:
        sio.enter_room(sid, room_id)
        sio.emit('new_message', msg, room=room_id)

    return {'success': True, 'message': msg}

@sio.event
def typing_start(sid, data=None):
    if data is None:
        data = {}
    user = users_by_socket.get(sid)
    room_id = data.get('roomId')
    if user and room_id:
        sio.emit('user_typing', {
            'roomId': room_id,
            'user': {'lanId': user['lanId'], 'username': user['username']}
        }, room=room_id, skip_sid=sid)

@sio.event
def typing_stop(sid, data=None):
    if data is None:
        data = {}
    user = users_by_socket.get(sid)
    room_id = data.get('roomId')
    if user and room_id:
        sio.emit('user_stop_typing', {
            'roomId': room_id,
            'user': {'lanId': user['lanId'], 'username': user['username']}
        }, room=room_id, skip_sid=sid)

@sio.event
def add_reaction(sid, data=None):
    if data is None:
        data = {}
    user = users_by_socket.get(sid)
    room_id = data.get('roomId')
    message_id = data.get('messageId')
    emoji = data.get('emoji')

    if not user or not room_id or not message_id or not emoji:
        return

    history = get_message_history(room_id)
    msg = next((m for m in history if m['id'] == message_id), None)
    if msg:
        if 'reactions' not in msg:
            msg['reactions'] = {}
        if emoji not in msg['reactions']:
            msg['reactions'][emoji] = []

        user_lan_id = user['lanId']
        if user_lan_id in msg['reactions'][emoji]:
            msg['reactions'][emoji].remove(user_lan_id)
            if not msg['reactions'][emoji]:
                del msg['reactions'][emoji]
        else:
            msg['reactions'][emoji].append(user_lan_id)

        sio.emit('message_reaction_updated', {
            'roomId': room_id,
            'messageId': message_id,
            'reactions': msg['reactions']
        }, room=room_id)
        save_users()

@sio.event
def disconnect(sid):
    user = users_by_socket.get(sid)
    if user:
        user['online'] = False
        del users_by_socket[sid]

        still_connected = any(u['lanId'] == user['lanId'] for u in users_by_socket.values())
        if not still_connected:
            users_by_lan_id[user['lanId']]['online'] = False

        sio.emit('users_list', list(users_by_lan_id.values()))
        print(f"User {user['username']} ({user['lanId']}) disconnected.")

def main():
    parser = argparse.ArgumentParser(description="LAN Mesh Chat Python Server")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"), help="Host IP address to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 3000)), help="Port to listen on (default: 3000)")
    args = parser.parse_args()

    host = args.host
    port = args.port
    app.config['PORT'] = port

    lan_ips = get_lan_ips()
    print("\n==================================================")
    print("🚀 LAN Chat Server active!")
    print(f"Local Access: http://localhost:{port}")
    for ip in lan_ips:
        print(f"LAN Access:   http://{ip}:{port}")
    print("==================================================\n")

    run_simple(host, port, wsgi_app, use_reloader=False, threaded=True)

if __name__ == '__main__':
    main()
