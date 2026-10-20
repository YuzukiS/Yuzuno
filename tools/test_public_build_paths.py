"""Exercise the release compiler flags with a real tiny Rust executable."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('build_core_artifact', Path(__file__).with_name('build-core-artifact.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PublicBuildPathsTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('rustc'), 'requires a local rustc; no download')
    def test_env_manifest_fallback_is_absent_only_in_bundled_release(self):
        with tempfile.TemporaryDirectory(prefix='private-runtime-path-') as tmp:
            root = Path(tmp)
            manifest = root / 'private-checkout' / 'core'
            manifest.mkdir(parents=True)
            module = root / 'runtime_paths.rs'
            module.write_bytes((builder.ROOT / 'core/src/runtime_paths.rs').read_bytes())
            source = root / 'main.rs'
            source.write_text('''mod runtime_paths;
fn main() {
    let supplied = std::path::PathBuf::from("/installed/bundle/bridge.mjs");
    assert_eq!(runtime_paths::resolve(Some(supplied.clone().into()), "claude/bridge.mjs"), Some(supplied));
    assert_eq!(runtime_paths::resolve(Some("".into()), "result-validator/validator.mjs"), None);
    for relative in ["claude/bridge.mjs", "result-validator/validator.mjs"] {
        match runtime_paths::resolve(None, relative) {
            Some(path) => println!("{}", path.display()),
            None => println!("unconfigured"),
        }
    }
}
''')
            env = builder.public_build_environment(os.environ, root, root / 'target')
            env['CARGO_MANIFEST_DIR'] = str(manifest)
            for bundled in (False, True):
                binary = root / ('bundled' if bundled else 'developer')
                flags = ['--cfg', 'feature="bundled-release"'] if bundled else []
                subprocess.run(['rustc', str(source), '-o', str(binary),
                                *env['CARGO_ENCODED_RUSTFLAGS'].split('\x1f'), *flags],
                               env=env, check=True, capture_output=True, timeout=60)
                output = subprocess.check_output([str(binary)], text=True).splitlines()
                if bundled:
                    self.assertEqual(output, ['unconfigured', 'unconfigured'])
                    builder.check_public_paths(binary, [manifest])
                else:
                    self.assertEqual(output, [str(manifest / '../runtimes' / relative)
                                              for relative in ('claude/bridge.mjs', 'result-validator/validator.mjs')])
                    with self.assertRaisesRegex(ValueError, 'Build-machine path remains'):
                        builder.check_public_paths(binary, [manifest])

    def test_encoded_flags_preserve_argument_boundaries_and_take_precedence(self):
        env = builder.public_build_environment({
            'HOME': '/private/example home', 'CARGO_HOME': '/private/cache',
            'RUSTFLAGS': '--cfg ignored',
            'CARGO_ENCODED_RUSTFLAGS': '--cfg\x1ffeature="example space"',
        }, Path('/private/example home/project'), Path('/private/build'))
        self.assertNotIn('RUSTFLAGS', env)
        self.assertEqual(env['CARGO_ENCODED_RUSTFLAGS'].split('\x1f')[:2],
                         ['--cfg', 'feature="example space"'])
        self.assertEqual(env['HOME'], '/private/example home')

    @unittest.skipUnless(shutil.which('rustc'), 'requires a local rustc; no download')
    def test_binary_and_file_macro_do_not_reveal_original_source_paths(self):
        with tempfile.TemporaryDirectory(prefix='private-build-path-') as tmp:
            home = Path(tmp) / 'builder home'
            root = home / 'checkout'
            cargo = home / 'cargo'
            target = home / 'output'
            for p in (root, cargo, target): p.mkdir(parents=True)
            dependency = cargo / 'dependency.rs'
            dependency.write_text('pub fn path() -> &' + "'static str { file!() }\n")
            source = root / 'main.rs'
            source.write_text(f'#[path = {str(dependency)!r}] mod dependency;\n'.replace("'", '"') +
                              'fn main() { println!("{}|{}", file!(), dependency::path()); }\n')
            env = builder.public_build_environment(dict(os.environ, HOME=str(home), CARGO_HOME=str(cargo)), root, target)
            binary = target / 'probe'
            subprocess.run(['rustc', str(source), '-o', str(binary),
                            *env['CARGO_ENCODED_RUSTFLAGS'].split('\x1f')], check=True,
                           capture_output=True, timeout=60)
            output = subprocess.check_output([str(binary)], text=True).strip()
            self.assertEqual(output, '/workspace/yuzuno/main.rs|/opt/cargo/dependency.rs')
            self.assertNotIn(str(home).encode(), binary.read_bytes())


if __name__ == '__main__':
    unittest.main()
