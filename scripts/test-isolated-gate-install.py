"""Host-independent installer boundary tests; no root account or service changes."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'selfhost'
UNIT_SOURCE = SOURCE / 'systemd/system'
spec = importlib.util.spec_from_file_location('installer', SOURCE / 'install-isolated-gate.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallationBoundary(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.archive = self.root / 'input.tar'
        self.payload = self.root / 'payload'
        self.payload.mkdir()
        self.metadata = {'version': 1, 'commit': 'a' * 40, 'tree': 'b' * 40, 'component': installer.ACCOUNT}
        self.files = {name: b'fixture' for name in installer.REQUIRED}
        self.files['bundle.json'] = json.dumps(self.metadata).encode()
        for name in installer.UNIT_NAMES:
            self.files['release/selfhost/systemd/system/' + name] = (UNIT_SOURCE / name).read_bytes()

    def bundle(self, extra=(), refresh=True):
        self.metadata['files'] = {name: hashlib.sha256(data).hexdigest() for name, data in self.files.items() if name != 'bundle.json'}
        if refresh and 'bundle.json' in self.files and json.loads(self.files['bundle.json']).get('commit') == 'a' * 40:
            self.files['bundle.json'] = json.dumps(self.metadata).encode()
        with tarfile.open(self.archive, 'w') as archive:
            for name, data in self.files.items():
                member = tarfile.TarInfo(name)
                member.mode = 0o755 if name == 'runtime/bin/node' else 0o644
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            for member in extra:
                archive.addfile(member, io.BytesIO(b''))
        return hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def verify(self, expected=None):
        digest = expected or self.bundle()
        snapshot = self.root / 'snapshot.tar'
        installer.snapshot(self.archive, snapshot, digest)
        return installer.extract(snapshot, self.payload)

    def test_capacity_preserves_a_two_gibibyte_reserve(self):
        from types import SimpleNamespace
        needed = installer.MAX_ARCHIVE + installer.MAX_EXPANDED + installer.MIN_ROOT_FREE
        with patch.object(installer.shutil, 'disk_usage', return_value=SimpleNamespace(free=needed)):
            installer.require_capacity(installer.MAX_ARCHIVE, installer.MAX_EXPANDED)
        with patch.object(installer.shutil, 'disk_usage', return_value=SimpleNamespace(free=needed - 1)):
            with self.assertRaises(ValueError): installer.require_capacity(installer.MAX_ARCHIVE, installer.MAX_EXPANDED)
        for size in [0, -1, installer.MAX_ARCHIVE + 1]:
            with self.subTest(size=size), self.assertRaises(ValueError): installer.require_capacity(size)

    def test_disabled_environment_never_provisions_a_signer(self):
        self.assertIn('XMTP_GATEKEEPER_ADDRESS=\n', installer.ENVIRONMENT)
        self.assertNotIn('XMTP_GATEKEEPER_PRIVATE_KEY', installer.ENVIRONMENT)
        self.assertIn('GATE_MEMBERSHIP_MODE=off', installer.ENVIRONMENT)
        self.assertNotIn('GATE_DB_ENCRYPTION_KEY=0x', installer.ENVIRONMENT)

    @unittest.skipUnless(os.geteuid() == 0, 'Requires the isolated root-filesystem fixture')
    def test_real_root_filesystem_verification_and_tamper_rejection(self):
        from types import SimpleNamespace
        import shutil
        verifier_spec = importlib.util.spec_from_file_location('gate_verifier', SOURCE / 'verify-isolated-gate.py')
        verifier = importlib.util.module_from_spec(verifier_spec); verifier_spec.loader.exec_module(verifier)
        self.verify()
        base = self.root / 'installed'; self.payload.rename(base)
        installer.protect_tree(base, 65534)
        config = self.root / 'configuration'; config.mkdir(mode=0o750); os.chown(config, 0, 65534)
        state = self.root / 'state'; state.mkdir(mode=0o700); os.chown(state, 65534, 65534)
        env = config / 'gate.env'; env.write_text(installer.ENVIRONMENT); env.chmod(0o600)
        receipt = config / 'install-receipt.json'
        receipt.write_text(json.dumps({**self.metadata, 'bundleSha256':'c'*64, 'enabled':False, 'identityProvisioned':False, 'activationApproved':False})); receipt.chmod(0o600)
        unit = self.root / 'installed.service'; shutil.copyfile(UNIT_SOURCE / 'bittrees-chat-gate.service', unit); unit.chmod(0o644)
        identity = SimpleNamespace(pw_uid=65534,pw_gid=65534,pw_shell='/usr/sbin/nologin',pw_dir=str(state))
        node = base / 'runtime/bin/node'; original = node.read_bytes()
        response = SimpleNamespace(stdout='ActiveState=inactive\nUnitFileState=disabled\nMainPID=0\n')
        def check(): return verifier.verify('a'*40,'b'*40,'c'*64,hashlib.sha256(original).hexdigest())
        with patch.multiple(verifier,BASE=base,CONFIG=config,STATE=state,UNIT=unit), \
             patch.object(verifier.pwd,'getpwnam',return_value=identity), \
             patch.object(verifier.grp,'getgrnam',return_value=SimpleNamespace(gr_gid=65534,gr_mem=[])), \
             patch.object(verifier.subprocess,'run',return_value=response), \
             patch.object(verifier.shutil,'disk_usage',return_value=SimpleNamespace(free=3*1024*1024*1024)):
            self.assertTrue(check()['installationVerified'])
            with self.assertRaises(ValueError): verifier.verify('d'*40,'b'*40,'c'*64,hashlib.sha256(original).hexdigest())
            for case in ['extra','hardlink','permissions','bytes','environment','state','activation','rooms','active']:
                with self.subTest(case=case):
                    extra = base / 'unexpected'; link = self.root / 'extra-link'; state_file=state/'unexpected'; marker=config/'activation-approved'; registry=config/'rooms.json'
                    try:
                        if case=='extra': extra.write_text('unreviewed')
                        if case=='hardlink': os.link(node,link)
                        if case=='permissions': node.chmod(0o570)
                        if case=='bytes': node.write_bytes(b'changed')
                        if case=='environment': env.write_text(installer.ENVIRONMENT+'XMTP_GATEKEEPER_PRIVATE_KEY=synthetic\n')
                        if case=='state': state_file.write_text('unexpected')
                        if case=='activation': marker.write_text('unexpected')
                        if case=='rooms': registry.write_text('[]')
                        if case=='active': response.stdout='ActiveState=active\nUnitFileState=enabled\nMainPID=12\n'
                        with self.assertRaises(ValueError): check()
                    finally:
                        for path in [extra,link,state_file,marker,registry]:
                            if path.exists(): path.unlink()
                        node.write_bytes(original); node.chmod(0o550); env.write_text(installer.ENVIRONMENT)
                        response.stdout='ActiveState=inactive\nUnitFileState=disabled\nMainPID=0\n'
            self.assertTrue(check()['installationVerified'])

    def test_valid_snapshot_discards_archive_write_permissions(self):
        self.assertEqual(self.verify(), self.metadata)
        self.assertEqual((self.payload / 'runtime/bin/node').stat().st_mode & 0o7777, 0o500)
        self.assertEqual((self.payload / 'release/package.json').stat().st_mode & 0o7777, 0o400)

    def test_wrong_digest_stops_before_extract(self):
        self.bundle()
        with self.assertRaises(ValueError):
            self.verify('0' * 64)
        self.assertEqual(list(self.payload.iterdir()), [])

    def test_changing_source_after_snapshot_does_not_change_installation(self):
        digest = self.bundle()
        copied = self.root / 'copied.tar'
        installer.snapshot(self.archive, copied, digest)
        self.archive.write_bytes(b'changed after snapshot')
        self.assertEqual(installer.extract(copied, self.payload), self.metadata)

    def test_reject_symlink_source(self):
        digest = self.bundle()
        link = self.root / 'link.tar'
        link.symlink_to(self.archive)
        with self.assertRaises(OSError):
            installer.snapshot(link, self.root / 'copied', digest)

    def test_reject_fifo_source_without_blocking(self):
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        with self.assertRaises(ValueError):
            installer.snapshot(fifo, self.root / 'copied', '0' * 64)

    def test_reject_overlarge_snapshot(self):
        digest = self.bundle()
        with patch.object(installer, 'MAX_ARCHIVE', 1), self.assertRaises(ValueError):
            self.verify(digest)

    def test_forbid_archive_traversal_and_ambiguous_names(self):
        for index, name in enumerate(('/tmp/escape', '../escape', 'release/../../escape',
                                      'release/./escape', 'release//escape', 'other/file',
                                      'release/back\\slash', 'release/line\nname')):
            with self.subTest(name=name):
                self.bundle([tarfile.TarInfo(name)])
                destination = self.root / str(index)
                destination.mkdir()
                with self.assertRaises(ValueError):
                    installer.extract(self.archive, destination)
        self.assertFalse((self.root / 'escape').exists())

    def test_forbid_links_devices_and_fifos(self):
        for index, kind in enumerate((tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE,
                                      tarfile.BLKTYPE, tarfile.FIFOTYPE)):
            with self.subTest(kind=kind):
                member = tarfile.TarInfo('release/evil')
                member.type, member.linkname = kind, '/etc/passwd'
                self.bundle([member])
                destination = self.root / str(index)
                destination.mkdir()
                with self.assertRaises(ValueError):
                    installer.extract(self.archive, destination)

    def test_forbid_duplicate_file(self):
        self.bundle([tarfile.TarInfo('release/package.json')])
        with self.assertRaises(ValueError):
            installer.extract(self.archive, self.payload)

    def test_expansion_limit(self):
        self.bundle()
        with patch.object(installer, 'MAX_EXPANDED', 1), self.assertRaises(ValueError):
            installer.extract(self.archive, self.payload)

    def test_entry_limit(self):
        self.bundle()
        with patch.object(installer, 'MAX_ENTRIES', 1), self.assertRaises(ValueError):
            installer.extract(self.archive, self.payload)

    def test_required_runtime_manifest_and_unit_files(self):
        for index, missing in enumerate(sorted(installer.REQUIRED)):
            with self.subTest(missing=missing):
                content = self.files.pop(missing)
                self.bundle()
                self.files[missing] = content
                destination = self.root / str(index)
                destination.mkdir()
                with self.assertRaises(ValueError):
                    installer.extract(self.archive, destination)

    def test_runtime_manifest_must_match_source(self):
        self.files['release/package-lock.json'] = b'changed dependencies'
        with self.assertRaises(ValueError):
            self.verify()

    def test_provenance_required(self):
        self.files['bundle.json'] = b'{"version":1,"commit":"main","tree":"unknown"}'
        with self.assertRaises(ValueError):
            self.verify()

    def test_installed_files_remain_disabled_without_secrets_or_journal(self):
        previous_umask = os.umask(0o077)
        self.addCleanup(os.umask, previous_umask)
        self.verify()
        target, config, state, units = [self.root / name for name in ('opt', 'etc', 'state', 'units')]
        units.mkdir()
        commands = []
        identity = type('Account', (), {'pw_uid': os.getuid(), 'pw_gid': os.getgid()})()
        # Actual filesystem install with only privileged ownership/account/systemd calls mocked.
        with patch.multiple(installer, TARGET=target, CONFIG=config, STATE=state, UNITS=units), \
             patch.object(installer.pwd, 'getpwnam', return_value=identity), \
             patch.object(installer.os, 'chown'), \
             patch.object(installer, 'run', side_effect=lambda *args: commands.append(args)):
            installer.install(self.payload, self.metadata, 'c' * 64)
        self.assertTrue((target / 'runtime/bin/node').exists())
        self.assertEqual((target / 'release/package.json').stat().st_mode & 0o777, 0o440)
        self.assertEqual(config.stat().st_mode & 0o777, 0o750)
        self.assertFalse((config / 'activation-approved').exists())
        self.assertFalse((config / 'rooms.json').exists())
        self.assertEqual((config / 'gate.env').stat().st_mode & 0o777, 0o600)
        self.assertEqual(state.stat().st_mode & 0o777, 0o700)
        self.assertEqual(list(state.iterdir()), [])
        environment = dict(line.split('=', 1) for line in (config / 'gate.env').read_text().splitlines() if '=' in line)
        self.assertEqual(environment['GATE_MEMBERSHIP_MODE'], 'off')
        self.assertEqual(environment['GATE_BIND_HOST'], '127.0.0.1')
        for key in ('XMTP_GATEKEEPER_ADDRESS', 'GATE_DB_ENCRYPTION_KEY', 'MAINNET_RPC_URL', 'GATE_PUBLIC_URL'):
            self.assertEqual(environment[key], '')
        self.assertFalse(any(arg in ('start', 'enable', 'restart', 'npm') for command in commands for arg in command))
        self.assertEqual(commands[-1], ('/usr/bin/systemctl', 'daemon-reload'))
        self.assertEqual(json.loads((config / 'install-receipt.json').read_text())['bundleSha256'], 'c' * 64)
        for name in installer.UNIT_NAMES:
            self.assertEqual((units / name).read_bytes(), (UNIT_SOURCE / name).read_bytes())

    def test_existing_paths_including_dangling_links_stop_before_mutation(self):
        parent = self.root / 'protected'
        parent.mkdir(mode=0o700)
        target = parent / 'existing'
        target.symlink_to(parent / 'missing')
        # Reach the real existence check independently of this unprivileged host's ownership.
        owner = parent.stat()
        protected = type('Stat', (), {'st_mode': owner.st_mode, 'st_uid': 0})()
        original = Path.lstat
        with patch.multiple(installer, TARGET=target, CONFIG=parent / 'config', STATE=parent / 'state', UNITS=parent), \
             patch.object(installer.os, 'geteuid', return_value=0), \
             patch.object(Path, 'lstat', lambda p: protected if p == parent else original(p)), \
             patch.object(installer, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'Existing installation'):
                installer.preflight()
            run.assert_not_called()

    @unittest.skipUnless(Path('/usr/bin/systemd-analyze').exists(), 'Requires Linux systemd tools')
    def test_actual_systemd_unit_verification(self):
        for name in installer.UNIT_NAMES:
            content = (UNIT_SOURCE / name).read_text()
            content = content.replace('/opt/bittrees-chat-gate/runtime/bin/node', '/usr/bin/true')
            (self.root / name).write_text(content)
        result = subprocess.run(['/usr/bin/systemd-analyze', 'verify', '--man=no', '--generators=no',
                                 *(str(self.root / name) for name in installer.UNIT_NAMES)],
                                capture_output=True, text=True, env=installer.COMMAND_ENV)
        self.assertEqual(result.returncode, 0, result.stderr)


    def test_rejects_manifest_tampering_and_missing_source_provenance(self):
        self.bundle()
        for patch_data in ({'component': 'other'}, {'files': {}}, {'tree': 'main'},
                           {'files': {**self.metadata['files'], 'runtime/bin/node': '0' * 64}}):
            with self.subTest(patch=patch_data):
                self.files['bundle.json'] = json.dumps({**self.metadata, **patch_data}).encode()
                self.bundle(refresh=False)
                with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
                    installer.extract(self.archive, Path(directory))

    def test_cli_verify_never_installs(self):
        import sys
        digest = self.bundle()
        result = subprocess.run([sys.executable, '-I', str(SOURCE / 'install-isolated-gate.py'),
                                 str(self.archive), '--sha256', digest, '--verify-only'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)['installed'])

    def lock_environment(self):
        from contextlib import ExitStack
        from types import SimpleNamespace
        parent = self.root / 'lock-parent'
        parent.mkdir(mode=0o700, exist_ok=True)
        lock = parent / 'install.lock'
        original_stat, original_fstat = Path.lstat, os.fstat
        def owned(info):
            return SimpleNamespace(st_mode=info.st_mode, st_uid=0, st_nlink=info.st_nlink)
        stack = ExitStack()
        stack.enter_context(patch.object(installer, 'LOCK', lock))
        stack.enter_context(patch.object(installer.os, 'geteuid', return_value=0))
        stack.enter_context(patch.object(Path, 'lstat', lambda p: owned(original_stat(p)) if p == parent else original_stat(p)))
        stack.enter_context(patch.object(installer.os, 'fstat', lambda fd: owned(original_fstat(fd))))
        return stack, lock

    def test_lock_excludes_concurrent_install_and_preserves_inode(self):
        stack, lock = self.lock_environment()
        with stack:
            with installer.installation_lock():
                first = lock.stat().st_ino
                with self.assertRaises(BlockingIOError), installer.installation_lock():
                    self.fail('Concurrent installer entered')
            with installer.installation_lock():
                self.assertEqual(lock.stat().st_ino, first)
        self.assertTrue(lock.exists())

    def test_lock_rejects_shared_permissions(self):
        stack, lock = self.lock_environment()
        with stack:
            lock.write_text('')
            lock.chmod(0o644)
            with self.assertRaises(ValueError), installer.installation_lock():
                self.fail('Insecure lock accepted')

    def test_lock_rejects_symlink(self):
        stack, lock = self.lock_environment()
        with stack:
            lock.symlink_to(self.root / 'not-created')
            with self.assertRaises(OSError), installer.installation_lock():
                self.fail('Symlink lock accepted')
        self.assertFalse((self.root / 'not-created').exists())

    # Verification coverage uses the real-root fixture above, including current
    # provenance arguments and actual ownership instead of forged stat records.



if __name__ == '__main__':
    unittest.main()
