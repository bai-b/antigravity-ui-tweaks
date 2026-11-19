"""把 antigravity-ui-tweaks 装到用户级插件目录，并启用它的 sidecar。

python install.py            安装并启用
python install.py --uninstall 卸载（删除插件目录与 sidecars 条目）
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory

SOURCE = Path(__file__).resolve().parent
CONFIG = (Path.home() / '.gemini' / 'config').resolve()
SETTINGS = CONFIG / 'config.json'
PLUGINS = CONFIG / 'plugins'
DESTINATION = PLUGINS / 'antigravity-ui-tweaks'
SIDECAR_ID = 'antigravity-ui-tweaks/theme'
PAYLOAD = ('plugin.json', 'skills', 'sidecars')
BACKUPS = CONFIG / '.ui-tweaks-backups'
MIN_NODE = (22, 13)


def node_version():
    """sidecar 用 PATH 里的 node 启动，版本不够会在运行时直接崩，所以在安装时就挡住。"""
    try:
        result = subprocess.run(['node', '--version'], capture_output=True, text=True, timeout=15, check=False)
    except (OSError, subprocess.SubprocessError):
        raise SystemExit('找不到 node。调校台用 PATH 里的 node 启动，请先装 Node.js 22.13 或更新版本。')
    match = re.fullmatch(r'\s*v(\d+)\.(\d+)\.\d+\s*', result.stdout or '')
    if result.returncode != 0 or not match:
        detail = (result.stdout or '').strip() or (result.stderr or '').strip() or '没有输出'
        raise SystemExit(f'读不到 node 版本（{detail}）。需要 Node.js 22.13 或更新版本。')
    if (int(match.group(1)), int(match.group(2))) < MIN_NODE:
        raise SystemExit(f'当前 node 是 {(result.stdout or "").strip()}，调校台需要 22.13 或更新版本（会话库要 node:sqlite）。')
    return (result.stdout or '').strip()


def update_config(path, change):
    CONFIG.mkdir(parents=True, exist_ok=True)
    for _ in range(3):
        original = path.read_bytes() if path.exists() else None
        config = json.loads(original.decode('utf-8-sig')) if original is not None else {}
        if not isinstance(config, dict):
            raise SystemExit(f'{path.name} 不是 JSON 对象，先修好它')
        if not change(config):
            return
        with NamedTemporaryFile(dir=CONFIG, prefix='.ui-tweaks-', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write((json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
        try:
            current = path.read_bytes() if path.exists() else None
            if current != original:
                continue
            temporary.replace(path)
            return
        finally:
            temporary.unlink(missing_ok=True)
    raise SystemExit('Antigravity 正在写配置。退出 App 后重试。')


def merge_sidecars(enabled):
    def change(config):
        sidecars = config.setdefault('sidecars', {})
        if not isinstance(sidecars, dict):
            raise SystemExit('config.json 的 sidecars 不是对象，先修好它')
        if not enabled:
            return sidecars.pop(SIDECAR_ID, None) is not None
        entry = sidecars.setdefault(SIDECAR_ID, {})
        if not isinstance(entry, dict):
            raise SystemExit('调校台的 sidecar 配置不是对象')
        if entry.get('enabled') is True:
            return False
        entry['enabled'] = True
        return True

    update_config(SETTINGS, change)


def remove_audit_hook():
    def change(config):
        return config.pop('antigravity-ui-tweaks-audit', None) is not None

    update_config(CONFIG / 'hooks.json', change)


def app_running():
    """sidecar 由 App 的 language_server 在启动时枚举，运行中的 App 不会发现新条目。"""
    if os.name != 'nt':
        return None
    try:
        result = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq Antigravity.exe', '/NH'],
                                capture_output=True, text=True, timeout=15, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return 'Antigravity.exe' in (result.stdout or '')


def verify():
    """安装后回读磁盘，确认文件、配置和版本都真的落下了。"""
    problems = []
    version = None
    manifest = DESTINATION / 'plugin.json'
    try:
        version = json.loads(manifest.read_text(encoding='utf-8')).get('version')
    except OSError:
        problems.append('插件没有部署到 ' + str(DESTINATION))
    except (ValueError, AttributeError):
        problems.append('plugin.json 读不出来')
    for name in PAYLOAD:
        if not (DESTINATION / name).exists():
            problems.append('缺少 ' + name)
    entry = {}
    try:
        entry = json.loads(SETTINGS.read_text(encoding='utf-8-sig')).get('sidecars', {}).get(SIDECAR_ID, {})
    except OSError:
        problems.append('没有 config.json')
    except (ValueError, AttributeError):
        problems.append('config.json 读不出来')
    if entry.get('enabled') is not True:
        problems.append('config.json 里 sidecar 没有启用')
    running = app_running()
    print('插件目录', DESTINATION, '·', '在位' if version else '缺失')
    print('版本', version or '未知')
    print('sidecar 条目', SIDECAR_ID, '·', '已启用' if entry.get('enabled') is True else '未启用')
    print('Antigravity', '正在运行' if running else '未运行' if running is False else '状态未知')
    if problems:
        for problem in problems:
            print('问题：', problem)
        return False
    if running:
        print('文件与配置都已就位，当前 App 不用退出。sidecar 由 language_server 在启动时枚举，')
        print('重启一次 Antigravity 后才会出现在 Customizations 与侧栏里。')
    else:
        print('下次启动 Antigravity 时会加载这个插件。')
    return True


def same_path():
    """直接从 ~/.gemini/config/plugins 里运行安装脚本时，复制会把自己的目录改名搬走。"""
    try:
        return SOURCE == DESTINATION.resolve()
    except OSError:
        return False


def copy_atomic(source, target):
    """宿主正打开着侧栏文件时，直接覆盖会被拒绝；先写同目录临时文件再替换。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + '.ui-tweaks-tmp')
    try:
        shutil.copy2(source, temporary)
        temporary.replace(target)
    except OSError:
        temporary.unlink(missing_ok=True)
        shutil.copy2(source, target)


def update_in_place(staging, backup):
    """目录被宿主占着改不了名时，退化成文件级覆盖，先把旧版整目录复制成备份。"""
    BACKUPS.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copytree(DESTINATION, backup, dirs_exist_ok=True)
    except OSError as error:
        print('旧版备份没做完（' + str(error) + '），继续更新。')
    for name in PAYLOAD:
        source = staging / name
        target = DESTINATION / name
        if source.is_dir():
            for item in source.rglob('*'):
                if item.is_file():
                    copy_atomic(item, target / item.relative_to(source))
        else:
            copy_atomic(source, target)


def install():
    node = node_version()
    if same_path():
        # git clone 到插件目录、或 agy plugin install 之后在这里补启用：只改 config.json，不动文件。
        merge_sidecars(True)
        print('node', node, '· 已经在插件目录里，跳过复制')
        print('sidecar 已启用：', SIDECAR_ID)
        return
    PLUGINS.mkdir(parents=True, exist_ok=True)
    backed_up = None
    with TemporaryDirectory(prefix='.ui-tweaks-install-', dir=CONFIG) as temporary:
        staging = Path(temporary) / 'staging'
        staging.mkdir()
        for name in PAYLOAD:
            source = SOURCE / name
            target = staging / name
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                shutil.copy2(source, target)
        # 上一版留在配置目录里，不再放进临时目录：重装既不销毁回滚点，也不丢用户改过的配方。
        in_place = False
        if DESTINATION.exists() or DESTINATION.is_symlink():
            BACKUPS.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
            backed_up = BACKUPS / f'install-{stamp}'
            if backed_up.exists():
                backed_up = BACKUPS / f'install-{stamp}-{datetime.now().strftime("%f")}'
            try:
                DESTINATION.rename(backed_up)
            except OSError as error:
                # 宿主打开着插件里的 sidecars/ 与 skills/ 时，整目录改名会被拒绝（WinError 5）。
                if getattr(error, 'winerror', None) not in (5, 32):
                    raise
                in_place = True
                update_in_place(staging, backed_up)
        if in_place:
            merge_sidecars(True)
            print('node', node, '· 插件目录被宿主占用，已就地更新到', DESTINATION)
            print('旧版备份在', backed_up, '（复制得到，不是整目录搬走）')
        else:
            deployed = False
            try:
                staging.rename(DESTINATION)
                deployed = True
                merge_sidecars(True)
            except (Exception, SystemExit):
                if deployed:
                    DESTINATION.rename(staging)
                if backed_up is not None:
                    backed_up.rename(DESTINATION)
                raise
    if not in_place:
        print('node', node, '· 已安装到', DESTINATION)
        if backed_up is not None:
            print('上一版已备份到', backed_up)
    print('sidecar 已启用：', SIDECAR_ID)
    if app_running():
        print('Antigravity 正在运行，安装不需要退出它：文件与配置已就位。')
        print('sidecar 由 language_server 在启动时枚举，所以重启一次 App 后才会出现在 Customizations 和侧栏里。')
    else:
        print('下次启动 Antigravity 时加载：Customizations → Installed 里应能看到 Antigravity 界面调校台。')
    print('也可以直接在聊天里发：[界面](sidecar://antigravity-ui-tweaks/theme/)')


def uninstall():
    remove_audit_hook()
    merge_sidecars(False)
    if DESTINATION.exists():
        shutil.rmtree(DESTINATION)
    print('已卸载', DESTINATION)


def main():
    parser = argparse.ArgumentParser(description='安装 Antigravity 界面调校台')
    parser.add_argument('--uninstall', action='store_true')
    parser.add_argument('--verify', action='store_true', help='只回读磁盘检查安装状态，不写任何文件')
    args = parser.parse_args()
    if args.verify:
        return 0 if verify() else 1
    (uninstall if args.uninstall else install)()
    return 0


if __name__ == '__main__':
    sys.exit(main())
