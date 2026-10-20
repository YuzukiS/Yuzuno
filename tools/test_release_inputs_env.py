"""Release inputs reject poisoned inherited tools and corrupt downloads."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_inputs_ci', Path(__file__).with_name('build-release-inputs-ci.py'))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class ReleaseInputsTests(unittest.TestCase):
    def test_prior_job_configuration_cannot_select_build_inputs(self):
        inherited = {key: '/poison' for key in (
            'PATH', 'CARGO_HOME', 'CARGO_TARGET_DIR', 'RUSTUP_HOME', 'RUSTC',
            'RUSTFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CC', 'LD',
            'PYTHONPATH', 'PYTHONHOME', 'NODE_OPTIONS', 'NPM_CONFIG_USERCONFIG',
            'GIT_CONFIG_GLOBAL', 'ZIG_GLOBAL_CACHE_DIR', 'CARGO_ZIGBUILD_ZIG_PATH',
            'PIP_INDEX_URL', 'GITHUB_TOKEN')}
        inherited.update(HOME='/real/home', GITHUB_SHA='a' * 40, GITHUB_RUN_ATTEMPT='2')
        env = ci.release_environment(Path('/fresh'), inherited)
        self.assertNotIn('/poison', '\n'.join(env.values()))
        for key in ('RUSTC', 'RUSTFLAGS', 'RUSTC_WRAPPER', 'CC', 'LD', 'PYTHONPATH',
                    'PYTHONHOME', 'NODE_OPTIONS', 'CARGO_ZIGBUILD_ZIG_PATH', 'PIP_INDEX_URL', 'GITHUB_TOKEN'):
            self.assertNotIn(key, env)
        self.assertEqual(env['HOME'], '/real/home')
        self.assertEqual(env['GITHUB_SHA'], 'a' * 40)
        self.assertEqual(env['GITHUB_RUN_ATTEMPT'], '2')
        # npm refuses loading one path as both the user and global config.
        self.assertNotEqual(env['NPM_CONFIG_USERCONFIG'], env['NPM_CONFIG_GLOBALCONFIG'])
        for key in ('CARGO_HOME', 'RUSTUP_HOME', 'CARGO_TARGET_DIR', 'NPM_CONFIG_CACHE',
                    'XDG_CACHE_HOME', 'ZIG_GLOBAL_CACHE_DIR', 'CARGO_ZIGBUILD_CACHE_DIR', 'TMPDIR'):
            self.assertTrue(Path(env[key]).is_relative_to('/fresh'), key)

    def test_corrupt_bootstrap_download_is_rejected(self):
        expected = hashlib.sha256(b'trusted').hexdigest()
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / 'download'
            with patch.object(ci.urllib.request, 'urlopen', return_value=io.BytesIO(b'changed')):
                with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
                    ci.download('https://example.invalid/pinned', destination, expected)
            with patch.object(ci.urllib.request, 'urlopen', return_value=io.BytesIO(b'trusted')):
                ci.download('https://example.invalid/pinned', destination, expected)
            self.assertEqual(destination.read_bytes(), b'trusted')
