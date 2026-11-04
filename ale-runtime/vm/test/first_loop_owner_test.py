import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / 'startup-script.sh'


class FirstLoopOwnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data = self.root / 'data'
        self.runtime = self.data / 'saleads' / 'runtime'
        self.runtime.mkdir(parents=True)
        (self.runtime / 'first-loop-exporter.py').write_text('# synthetic exporter fixture\n')
        self.stage = self.root / 'stage'
        self.stage.mkdir()
        (self.stage / 'hermes-first-loop-url').write_text('https://example.invalid/no-upload')
        self.owner = f'{os.getuid()}:{os.getgid()}'
        self.commands = self.root / 'commands'

    def tearDown(self):
        self.tmp.cleanup()

    def apply(self):
        # Record owner operations without requiring privileged chown on the developer host.
        command = r'''
source "$1"
running() { return 0; }
guest_put() { :; }
chown() { printf 'owner %s %s\n' "$1" "$2" >>"$TEST_COMMANDS"; }
test_docker() { printf 'docker'; printf ' <%s>' "$@"; printf '\n'; } >>"$TEST_COMMANDS"
DOCKER=test_docker
apply_first_loop_snapshot "$2"
'''
        return subprocess.run(
            ['bash', '-c', command, 'test', str(SCRIPT), str(self.stage)],
            env={**os.environ, 'HERMES_ROOT': str(self.root), 'HERMES_DATA_DIR': str(self.data),
                 'HERMES_STATE_DIR': str(self.root / 'state'), 'HERMES_OWNER': self.owner,
                 'TEST_COMMANDS': str(self.commands)}, capture_output=True, text=True, timeout=10,
        )

    def test_repairs_existing_private_parent_and_creates_only_owned_fixed_directories(self):
        parent = self.data / 'saleads' / 'first-loop'
        parent.mkdir(mode=0o755)
        saved = parent / 'owner-content.txt'
        saved.write_text('preserve existing owner content')
        saved.chmod(0o600)
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.commands.read_text()
        for directory in [parent, parent / 'flows', parent / 'works']:
            self.assertTrue(directory.is_dir(), str(directory))
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            self.assertIn(f'owner {self.owner} {directory}\n', calls)
        self.assertEqual(saved.read_text(), 'preserve existing owner content')
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(f'owner {self.owner} {saved}', calls)
        self.assertNotIn('owner -R', calls)
        self.assertIn(f'docker <exec> <--user> <{self.owner}> <hermes>', calls)
        self.assertNotIn('snapshot.json.gz', calls)

    def test_symlinked_fixed_directory_is_rejected_without_export_or_owner_changes(self):
        for relative in ['', 'flows', 'works']:
            with self.subTest(relative=relative):
                parent = self.data / 'saleads' / 'first-loop'
                target = self.root / ('external-' + (relative or 'parent'))
                target.mkdir()
                if relative:
                    parent.mkdir(exist_ok=True)
                    link = parent / relative
                else:
                    link = parent
                link.symlink_to(target, target_is_directory=True)
                self.commands.unlink(missing_ok=True)
                self.apply()
                self.assertFalse(self.commands.exists(), 'symlinks must not reach chown or exporter')
                self.assertEqual(list(target.iterdir()), [])
                link.unlink()
                if relative:
                    parent.rmdir()

    def test_absent_first_loop_metadata_does_not_change_classic_assistant_directories(self):
        (self.stage / 'hermes-first-loop-url').unlink()
        self.assertEqual(self.apply().returncode, 0)
        self.assertFalse((self.data / 'saleads' / 'first-loop').exists())
        self.assertFalse(self.commands.exists())


if __name__ == '__main__':
    unittest.main()
