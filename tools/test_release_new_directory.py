"""A release its baseline cannot take as an update, which installs into a new
data directory (docs/adr/0002-session-store-new-data-directory.md): how it is
frozen, which smoke it gets and what its health reads. No Core, network or keys."""
import argparse
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from release_common import read, write

spec = importlib.util.spec_from_file_location('release_flow', Path(__file__).with_name('core-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

spec = importlib.util.spec_from_file_location('release_smoke', Path(__file__).with_name('core-release-smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

# The storage spans of core.19 and of the session store's first release.
ROWS = {'schema': {'writes': 2, 'readsMin': 2, 'readsMax': 2}, 'records': {'writes': 1, 'readsMin': 0, 'readsMax': 1}}
SESSION_STORE = {'schema': {'writes': 2, 'readsMin': 2, 'readsMax': 2}, 'records': {'writes': 2, 'readsMin': 2, 'readsMax': 2}}


class UpgradeModeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def bundle(self, name, spans):
        path = self.base / name
        path.mkdir()
        write(path / 'manifest.json', {'releaseId': name, 'files': {}, **spans})
        return path

    def test_in_place_follows_core_update_admission_both_ways(self):
        self.assertTrue(smoke.upgrades_in_place(ROWS, ROWS))
        self.assertTrue(smoke.upgrades_in_place(SESSION_STORE, SESSION_STORE))
        # The candidate cannot read the baseline's records, and the baseline
        # could not read the candidate's after a rollback.
        self.assertFalse(smoke.upgrades_in_place(ROWS, SESSION_STORE))
        reads_both = {**SESSION_STORE, 'records': {'writes': 2, 'readsMin': 1, 'readsMax': 2}}
        self.assertFalse(smoke.upgrades_in_place(ROWS, reads_both), 'core.19 cannot read records it would roll back to')
        newer_schema = {**ROWS, 'schema': {'writes': 3, 'readsMin': 2, 'readsMax': 3}}
        self.assertFalse(smoke.upgrades_in_place(ROWS, newer_schema))

    def test_record_layouts_are_read_as_core_reads_them_without_writing_beside_the_database(self):
        cases = [('rows', 'CREATE TABLE agents(id TEXT PRIMARY KEY, layout INTEGER NOT NULL, data TEXT NOT NULL);'
                  "INSERT INTO agents VALUES('a', 1, '{}');", [1]),
                 ('session-store', 'CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);'
                  "INSERT INTO agents VALUES('a', '{}'); INSERT INTO workspace_meta VALUES('sessionStore', '2');", [2]),
                 ('empty-session-store', 'CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);'
                  "INSERT INTO workspace_meta VALUES('sessionStore', '2');", []),
                 ('whole-json', 'CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);'
                  "INSERT INTO agents VALUES('a', '{}');", [0])]
        scratch = self.base / 'scratch'
        scratch.mkdir()
        for name, sql, layouts in cases:
            data = self.base / name
            data.mkdir()
            db = smoke.sqlite3.connect(data / 'workspace.sqlite')
            db.executescript('CREATE TABLE workspace_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);' + sql)
            db.close()
            before = smoke.data_files(data)
            with self.subTest(name):
                self.assertEqual(smoke.record_layouts(data, scratch), layouts)
                self.assertEqual(smoke.data_files(data), before)
        self.assertEqual(list(scratch.iterdir()), [])

    def test_a_smoke_of_the_other_mode_stops_before_any_installation(self):
        rows, rows_next, store = self.bundle('core-rows', ROWS), self.bundle('core-rows-next', ROWS), self.bundle('core-store', SESSION_STORE)
        cases = [(rows, store, False, 'cannot take this candidate as an update'),
                 (rows, rows_next, True, 'use the in-place smoke')]
        for baseline, candidate, new_directory, message in cases:
            state = self.base / f'{candidate.name}-{new_directory}.json'
            with self.subTest(candidate=candidate.name, new_directory=new_directory), \
                 patch.object(smoke.tempfile, 'mkdtemp', side_effect=AssertionError('an installation was made')):
                with self.assertRaisesRegex(ValueError, message):
                    smoke.smoke(argparse.Namespace(baseline=baseline, candidate=candidate, state=state,
                                                   new_data_directory=new_directory))
                self.assertFalse(state.exists())


class NewDirectoryFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        baseline = self.base / 'baseline'
        baseline.mkdir()
        write(baseline / 'manifest.json', {'releaseId': 'core-before'})
        (self.base / 'publisher.pub').write_text('unit test placeholder, never signed')
        (self.base / 'notes.txt').write_text('Reviewed changes')
        self.args = dict(repository='owner/repo', sha='a' * 40, release_id='core-test', version='test.1',
            review='Accepted PR review reference', ci_run=42, artifact_id=7, baseline=baseline,
            public_key=self.base / 'publisher.pub', notes=self.base / 'notes.txt')

    def flow(self, name, **extra):
        release.initialize(argparse.Namespace(work_dir=self.base / name, **self.args, **extra))
        return release.Flow(self.base / name)

    def smoked(self, flow, receipt):
        """The smoke stage with the smoke itself replaced by `receipt`; returns its argv."""
        argv = []
        def execute(command):
            argv.extend(map(str, command))
            write(flow.root / 'smoke.json', receipt)
        with patch.object(flow, 'signed'), patch.object(flow, 'execute', side_effect=execute):
            try:
                flow.run('smoke', flow.smoke)
            finally:
                self.argv = argv

    def test_only_the_named_release_is_frozen_for_a_new_directory(self):
        self.assertEqual(self.flow('new', new_data_directory=True).config['upgrade'], 'newDataDirectory')
        # An earlier release's frozen inputs stay exactly as they were.
        self.assertNotIn('upgrade', self.flow('in-place').config)
        self.assertNotIn('upgrade', self.flow('in-place-explicit', new_data_directory=False).config)

    def test_the_smoke_runs_in_the_frozen_mode_and_its_receipt_must_say_so(self):
        flow = self.flow('new', new_data_directory=True)
        with self.assertRaisesRegex(ValueError, 'another upgrade mode'):
            self.smoked(flow, {'inputs': {}, 'passed': True})
        self.assertIn('--new-data-directory', self.argv)
        self.smoked(flow, {'inputs': {'mode': 'newDataDirectory'}, 'passed': True})
        self.assertEqual(flow.report['stages']['smoke']['status'], 'passed')
        self.assertEqual([a['status'] for a in flow.report['attempts']], ['failed', 'passed'], 'the failed attempt is kept')

        in_place = self.flow('in-place')
        with self.assertRaisesRegex(ValueError, 'another upgrade mode'):
            self.smoked(in_place, {'inputs': {'mode': 'newDataDirectory'}, 'passed': True})
        self.assertNotIn('--new-data-directory', self.argv)

    def test_a_failed_new_directory_smoke_still_stops_publication(self):
        flow = self.flow('new', new_data_directory=True)
        with self.assertRaisesRegex(ValueError, 'did not pass'):
            self.smoked(flow, {'inputs': {'mode': 'newDataDirectory'}, 'passed': False})
        self.assertEqual(flow.report['resumeAt'], 'smoke')
        with self.assertRaisesRegex(ValueError, 'smoke must pass before publishing'):
            flow.publish()

    def test_health_of_a_new_installation_has_no_update_to_prove(self):
        def answered(updates):
            values = {'health': {'releaseId': 'core-test', 'workspaceId': 'ws-new', 'apiReady': True, 'storageReady': True},
                      'updates': updates}
            class Opener:
                def open(self, url, timeout):
                    return io.BytesIO(json.dumps(values[url.rsplit('/', 1)[1]]).encode())
            return patch.object(release.urllib.request, 'build_opener', return_value=Opener())
        flow = self.flow('new', new_data_directory=True)
        with answered({'acceptingWork': True}):
            flow.health('http://127.0.0.1:4317', 'ws-new')
        self.assertEqual(read(flow.root / 'health.json')['health']['workspaceId'], 'ws-new')
        with answered({'acceptingWork': True, 'operation': {'phase': 'complete'}}), \
             self.assertRaisesRegex(ValueError, 'has an update operation'):
            flow.health('http://127.0.0.1:4317', 'ws-new')
        # An upgraded release still needs its restoration proof.
        with answered({'acceptingWork': True}), self.assertRaisesRegex(ValueError, 'recovery proof'):
            self.flow('in-place').health('http://127.0.0.1:4317', 'ws-new')


if __name__ == '__main__':
    unittest.main()
