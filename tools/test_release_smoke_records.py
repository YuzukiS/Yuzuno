"""The release smoke's check of the seeded project, task and saved budget
after an upgrade (T-54): every field the baseline gave is kept as it was,
and a newer Core may add fields, as core.24 adds a project's task key
(T-56). Fixture answers only; no Core."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('release_smoke', Path(__file__).with_name('core-release-smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

SEEDED = {
    'project': {'id': 'p1', 'name': 'Release smoke retained project', 'defaultDirs': {}, 'archivedAt': None,
                'createdAt': 't0', 'updatedAt': 't0'},
    'task': {'id': 'T-1', 'title': 'Release smoke retained task', 'projectId': 'p1', 'status': 'todo', 'version': 1},
    'budget': {'cpuMillis': 200, 'memoryMiB': 128, 'swapMiB': 0},
}


def answers():
    return copy.deepcopy([SEEDED['project'], {'id': 'p2', 'name': 'other'}]), copy.deepcopy(SEEDED['task']), copy.deepcopy(SEEDED['budget'])


class SeededRecords(unittest.TestCase):
    def test_unchanged_records_pass_with_nothing_added(self):
        self.assertEqual(smoke.records_problem(SEEDED, *answers()), (None, {}))

    def test_a_field_a_newer_core_adds_passes_and_is_named(self):
        projects, task, budget = answers()
        projects[0]['key'] = 'RSRP'
        budget['maxActive'] = 4
        self.assertEqual(smoke.records_problem(SEEDED, projects, task, budget),
                         (None, {'project': ['key'], 'budget': ['maxActive']}))

    def test_a_changed_or_lost_field_stops_the_smoke(self):
        for name, change in (('project', lambda p, t, b: p[0].update(name='renamed')),
                             ('task', lambda p, t, b: t.pop('title')),
                             ('budget', lambda p, t, b: b.update(memoryMiB=256))):
            projects, task, budget = answers()
            change(projects, task, budget)
            problem, _ = smoke.records_problem(SEEDED, projects, task, budget)
            self.assertEqual(problem, f'the seeded {name} lost or changed a field', name)

    def test_a_missing_project_stops_the_smoke(self):
        projects, task, budget = answers()
        problem, _ = smoke.records_problem(SEEDED, projects[1:], task, budget)
        self.assertEqual(problem, 'the seeded project lost or changed a field')


if __name__ == '__main__':
    unittest.main()
