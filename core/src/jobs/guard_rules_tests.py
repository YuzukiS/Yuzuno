#!/usr/bin/env python3
"""The shared guard rules answer as the two helpers did before they shared
them (YN-207 slice 1).

host.py and remote_job.py now carry the same rule source
(core/src/jobs/guard_rules.py); this test holds the new rules to the copies
each end had at the design's baseline (5e456356, unchanged in this area at
0fbfb4e3), byte for byte on the same frozen facts, and to each other. It also
checks the facts a snapshot keeps, so an existing queued or finished record
still reads as before.

Run by remote_tests.rs with HOME and TMPDIR in a test folder:
    python3 -I -B guard_rules_tests.py <host.py> <remote_job.py> <guard_rules.py>
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HOST = load("host", sys.argv[1])
REMOTE = load("remote_job", sys.argv[2])
RULES = load("guard_rules", sys.argv[3])

# The rule as host.py had it before the two ends shared it: what this test
# holds the new answer to. Frozen on purpose, never edited with the product.
def old_local_compared(value):
    git = value.get('git')
    if not (isinstance(git, dict) and 'guardPaths' in git):
        return value
    return {**value, 'git': {k: v for k, v in git.items() if k != 'head'}}


def old_local_changed_inputs(frozen, current):
    changed = []
    before_git, after_git = frozen.get('git') or {}, current.get('git') or {}
    if 'guardPaths' in before_git:
        after = {g['path']: (g['object'], g['type']) for g in after_git.get('guardPaths') or []}
        changed += ["the committed content of guarded path " + g['path'] for g in before_git['guardPaths']
                    if after.get(g['path']) != (g['object'], g['type'])]
    elif before_git.get('head') != after_git.get('head'):
        changed.append('the Git commit')
    before = {f['path']: f['sha256'] for f in frozen.get('files', [])}
    after = {f['path']: f['sha256'] for f in current.get('files', [])}
    changed += [p for p in sorted(set(before) | set(after)) if before.get(p) != after.get(p)]
    return changed


def old_local_shown_list(changed):
    return ', '.join(changed[:5]) + (" and %d more" % (len(changed) - 5) if len(changed) > 5 else '')


def old_local_guard_reason(spec, current):
    frozen = spec['snapshot']
    changed = old_local_changed_inputs(frozen, current)
    if frozen.get('resumeFrom') != current.get('resumeFrom'):
        changed.append('the checkpoint it resumes from')
    if not changed:
        changed.append('the list of changed tracked files')
    hint = (" If an earlier stage writes a tracked file, declare it as that stage's artifact."
            if spec.get('run') else '')
    return "Guarded inputs changed while queued (%s); command was not started.%s" % (
        old_local_shown_list(changed), hint)


# And as remote_job.py had it.
def old_remote_git_changes(before, after):
    if 'guardPaths' in before:
        found = {g['path']: (g['object'], g['type']) for g in after.get('guardPaths') or []}
        return ["the committed content of guarded path %s" % g['path'] for g in before['guardPaths']
                if found.get(g['path']) != (g['object'], g['type'])]
    return ["the Git commit"] if before.get('head') != after.get('head') else []


def old_remote_guard_reason(spec, now, tracked, changed):
    items = old_remote_git_changes(spec['git']['frozen'] or {}, now or {})
    frozen = {i['path'] for i in spec.get('inputs') or []}
    items += changed + [p for p in tracked if p not in frozen]
    hint = " If an earlier stage writes a tracked file, declare it as that stage's artifact." if "needs" in spec else ""
    return "Guarded inputs changed while queued (%s); command was not started.%s" % (
        ", ".join(items[:5]) + (" and %d more" % (len(items) - 5) if len(items) > 5 else "")
        or "the list of changed tracked files", hint)


HEAD = 'a' * 40
OTHER = 'b' * 40
SHA = 'c' * 64
HINT = " If an earlier stage writes a tracked file, declare it as that stage's artifact."


def git(head=HEAD, status=SHA, paths=None):
    value = {'root': '/w', 'head': head, 'statusSha256': status}
    if paths is not None:
        value['guardPaths'] = paths
    return value


def file(path, digest):
    return {'path': path, 'sha256': digest}


class Rules(unittest.TestCase):
    """The shared facts themselves: bounds, truncation, parsing, scope."""

    def test_the_bounds_are_the_ones_both_ends_had(self):
        self.assertEqual((RULES.INPUT_FILE_LIMIT, RULES.INPUT_TOTAL_LIMIT, RULES.INPUT_COUNT_LIMIT,
                          RULES.GIT_STATUS_LIMIT), (2 * 1024 * 1024, 16 * 1024 * 1024, 128, 64 * 1024))

    def test_a_change_list_shows_five_and_counts_the_rest(self):
        for items, shown in (([], ''), (['one'], 'one'), (['a', 'b', 'c', 'd', 'e', 'f'], 'a, b, c, d, e and 1 more'),
                             (['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'a, b, c, d, e and 2 more')):
            self.assertEqual(RULES.shown_list(items), shown)
            self.assertEqual(HOST.shown_list(items), REMOTE.shown_list(items))

    def test_a_guarded_paths_object_is_read_from_git_cat_files_answer(self):
        scope = [('src', 'src'), ('new', 'new'), ('', '')]
        answers = ['%s tree %d' % (HEAD, 1), 'missing', '%s blob 3' % (OTHER,)]
        expected = [{'path': 'src', 'object': HEAD, 'type': 'tree'},
                    {'path': 'new', 'object': None, 'type': None},
                    {'path': '', 'object': OTHER, 'type': 'blob'}]
        self.assertEqual(RULES.guard_objects_from(scope, answers), expected)
        # Another type, or a line with the wrong shape, is no object.
        self.assertEqual(RULES.guard_objects_from([('x', 'x')], ['%s tag 1' % SHA]),
                         [{'path': 'x', 'object': None, 'type': None}])
        self.assertEqual(RULES.guard_objects_from([('x', 'x')], ['%s blob' % SHA]),
                         [{'path': 'x', 'object': None, 'type': None}])

    def test_a_guarded_path_outside_the_work_tree_is_refused_in_the_same_words(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            self.assertEqual(HOST.guard_scope(['src', './src/'], root, root), [('src', 'src'), ('./src/', 'src')])
            self.assertEqual(REMOTE.guard_scope([], root, root), [])
            for paths in (['../..'], ['/outside']):
                with self.assertRaises(HOST.InputGuard) as caught:
                    HOST.guard_scope(paths, root / 'sub', root)
                self.assertEqual(str(caught.exception),
                                 'guardPaths must be inside the Git work tree of cwd (%s): %s is not' % (root, paths[0]))
                self.assertEqual(caught.exception.detail['limit'], 'guardPath')
                self.assertEqual(caught.exception.detail['path'], paths[0])
            with self.assertRaises(REMOTE.InputGuard) as caught:
                REMOTE.guard_scope(['a\nb'], root, root)
            self.assertEqual(str(caught.exception), "guardPaths cannot contain a line break: 'a\\nb'")

    def test_the_refusal_is_a_runtime_error_at_both_ends(self):
        self.assertTrue(issubclass(HOST.InputGuard, RuntimeError))
        self.assertTrue(issubclass(REMOTE.InputGuard, RuntimeError))
        error = HOST.InputGuard('problem', limit='count', count=3)
        self.assertEqual(error.detail, {'problem': 'problem', 'limit': 'count', 'count': 3})
        self.assertEqual(REMOTE.InputGuard('problem').detail, {'problem': 'problem'})


class LocalCompatibility(unittest.TestCase):
    """host.py's snapshot, compared and refusal: the same facts as before."""

    def check(self, frozen, current, spec=None, run=False):
        spec = dict(spec if spec is not None else {}, snapshot=frozen)
        if run:
            spec['run'] = {'id': 'r'}
        old = old_local_guard_reason(spec, current)
        new = HOST.guard_reason(spec, current)
        differs = old_local_compared(frozen) != old_local_compared(current)
        self.assertEqual(new is not None, differs, 'start decision: %r %r' % (frozen, current))
        if differs:
            self.assertEqual(new, old)
        else:
            self.assertTrue(old.endswith('the list of changed tracked files); command was not started.'), old)
        self.assertEqual(HOST.compared(frozen), old_local_compared(frozen))
        self.assertEqual(HOST.changed_inputs(frozen, current), old_local_changed_inputs(frozen, current))
        return new

    def test_nothing_changed_allows_the_start(self):
        frozen = {'cwd': '/w', 'git': git(), 'files': [file('/w/a', SHA)]}
        self.assertIsNone(self.check(frozen, frozen))

    def test_a_changed_file_is_named_by_its_path(self):
        frozen = {'cwd': '/w', 'git': git(), 'files': [file('/w/a', SHA)]}
        current = {'cwd': '/w', 'git': git(), 'files': [file('/w/a', OTHER)]}
        self.assertIn('/w/a', self.check(frozen, current))

    def test_a_missing_digest_only_equals_another_missing_one(self):
        frozen = {'cwd': '/w', 'git': None, 'files': [file('/w/gone', None), file('/w/here', SHA)]}
        same = {'cwd': '/w', 'git': None, 'files': [file('/w/gone', None), file('/w/here', SHA)]}
        self.assertIsNone(self.check(frozen, same))
        appeared = {'cwd': '/w', 'git': None, 'files': [file('/w/gone', SHA), file('/w/here', SHA)]}
        self.assertIn('/w/gone', self.check(frozen, appeared))
        gone = {'cwd': '/w', 'git': None, 'files': [file('/w/here', SHA)]}
        # A path one side no longer lists is a change, though neither recorded
        # a digest for it: refused by the fallback, as before.
        self.assertEqual(self.check(frozen, gone),
                         'Guarded inputs changed while queued (the list of changed tracked files); command was not started.')
        had = {'cwd': '/w', 'git': None, 'files': [file('/w/gone', SHA), file('/w/here', SHA)]}
        self.assertIn('/w/gone', self.check(had, gone))

    def test_every_snapshot_key_decides_as_before(self):
        """cwd, scope, a key added later and the files' order all still refuse:
        they are not in the named facts, so the old fallback sentence is used."""
        frozen = {'cwd': '/w', 'git': git(), 'files': [file('/w/a', SHA), file('/w/b', SHA)],
                  'scope': 'Frozen argv/env/resources; the old words.', 'resumeFrom': None}
        fallback = 'Guarded inputs changed while queued (the list of changed tracked files); command was not started.'
        for change in ({'cwd': '/v'}, {'scope': 'Frozen argv/env/resources; new words.'},
                       {'added': {'by': 'a later wrapper'}}, {'files': [file('/w/b', SHA), file('/w/a', SHA)]}):
            current = dict(frozen, **change)
            self.assertEqual(self.check(frozen, current), fallback, change)

    def test_a_record_written_by_an_older_wrapper_still_matches_or_refuses(self):
        # Equal records of every shape allow the start, including an older one
        # without resumeFrom and one carrying keys this wrapper does not know.
        for frozen in ({'cwd': '/w', 'git': git(), 'files': []},
                       {'cwd': '/w', 'git': None, 'files': [], 'resumeFrom': {'jobId': 'j'}},
                       {'cwd': '/w', 'git': git(), 'files': [], 'legacy': {'attempt': 'a'}}):
            self.assertIsNone(self.check(frozen, dict(frozen)), frozen)
        old = {'cwd': '/w', 'git': git(), 'files': []}
        self.assertIn('the checkpoint it resumes from',
                      self.check(old, {'cwd': '/w', 'git': git(), 'files': [],
                                       'resumeFrom': {'jobId': 'j', 'attempt': 'a', 'manifestSha256': SHA}}))
        # A record frozen before a key existed differs from what this wrapper
        # computes now: refused, by the fallback, never silently accepted.
        self.assertEqual(self.check(old, dict(old, scope='a key a later wrapper added')),
                         'Guarded inputs changed while queued (the list of changed tracked files); '
                         'command was not started.')

    def test_a_moved_commit_is_the_git_commit(self):
        frozen = {'cwd': '/w', 'git': git(), 'files': []}
        current = {'cwd': '/w', 'git': git(head=OTHER), 'files': []}
        self.assertEqual(self.check(frozen, current),
                         'Guarded inputs changed while queued (the Git commit); command was not started.')

    def test_staging_alone_still_refuses_with_the_fallback(self):
        # The status digest moved, the commit and every file are as they were:
        # the tree is not the one that was frozen.
        frozen = {'cwd': '/w', 'git': git(), 'files': [file('/w/a', SHA)]}
        current = {'cwd': '/w', 'git': git(status=OTHER), 'files': [file('/w/a', SHA)]}
        self.assertEqual(self.check(frozen, current),
                         'Guarded inputs changed while queued (the list of changed tracked files); command was not started.')

    def test_with_guard_paths_a_commit_elsewhere_is_allowed(self):
        frozen = {'cwd': '/w', 'git': git(paths=[{'path': 'src', 'object': SHA, 'type': 'tree'}]),
                  'files': [file('/w/src/a', SHA)]}
        current = {'cwd': '/w', 'git': git(head=OTHER, paths=[{'path': 'src', 'object': SHA, 'type': 'tree'}]),
                   'files': [file('/w/src/a', SHA)]}
        self.assertIsNone(self.check(frozen, current))
        self.assertEqual(HOST.compared(frozen), old_local_compared(frozen))

    def test_with_guard_paths_the_status_digest_still_counts(self):
        frozen = {'cwd': '/w', 'git': git(paths=[{'path': 'src', 'object': SHA, 'type': 'tree'}]), 'files': []}
        current = {'cwd': '/w', 'git': git(head=OTHER, status=OTHER, paths=[{'path': 'src', 'object': SHA, 'type': 'tree'}]),
                   'files': []}
        self.assertEqual(self.check(frozen, current),
                         'Guarded inputs changed while queued (the list of changed tracked files); command was not started.')

    def test_with_guard_paths_a_changed_object_is_named_as_the_submission_named_it(self):
        frozen = {'cwd': '/w', 'git': git(paths=[{'path': 'src', 'object': SHA, 'type': 'tree'},
                                                  {'path': 'new', 'object': None, 'type': None}]), 'files': []}
        current = {'cwd': '/w', 'git': git(paths=[{'path': 'src', 'object': OTHER, 'type': 'tree'},
                                                   {'path': 'new', 'object': HEAD, 'type': 'blob'}]), 'files': []}
        self.assertEqual(self.check(frozen, current),
                         'Guarded inputs changed while queued (the committed content of guarded path src, '
                         'the committed content of guarded path new); command was not started.')

    def test_the_checkpoint_a_resume_would_use_is_named_last(self):
        frozen = {'cwd': '/w', 'git': git(), 'files': [file('/w/a', SHA)],
                  'resumeFrom': {'jobId': 'j', 'attempt': 'a', 'manifestSha256': SHA}}
        current = {'cwd': '/w', 'git': git(), 'files': [file('/w/a', OTHER)]}
        self.assertEqual(self.check(frozen, current),
                         'Guarded inputs changed while queued (/w/a, the checkpoint it resumes from); '
                         'command was not started.')

    def test_an_earlier_stage_gets_the_hint_and_a_plain_job_does_not(self):
        frozen = {'cwd': '/w', 'git': git(), 'files': [file('/w/a', SHA)]}
        current = {'cwd': '/w', 'git': git(), 'files': [file('/w/a', OTHER)]}
        self.assertTrue(self.check(frozen, current, run=True).endswith(HINT))
        self.assertFalse(self.check(frozen, current).endswith('artifact.'))

    def test_the_snapshot_keeps_its_keys_and_file_shape(self):
        with tempfile.TemporaryDirectory() as folder:
            cwd = Path(folder).resolve()
            (cwd / 'a.txt').write_text('a\n')
            subprocess.run(['git', 'init', '-q'], cwd=str(cwd), check=True)
            subprocess.run(['git', 'add', '.'], cwd=str(cwd), check=True)
            subprocess.run(['git', '-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid',
                            'commit', '-qm', 'one'], cwd=str(cwd), check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            value = HOST.snapshot({'cwd': str(cwd), 'guardGit': True, 'inputs': ['a.txt']})
            self.assertEqual(set(value), {'cwd', 'git', 'files', 'scope'})
            self.assertEqual(set(value['git']), {'root', 'head', 'statusSha256'})
            self.assertEqual(set(value['files'][0]), {'path', 'sha256'})


class RemoteCompatibility(unittest.TestCase):
    """remote_job.py's start check answers as its own guard_reason did."""

    def check(self, spec, frozen, now, tracked, changed):
        old = old_remote_guard_reason(spec, now, tracked, changed)
        named = {i['path'] for i in spec.get('inputs') or []}
        hint = " If an earlier stage writes a tracked file, declare it as that stage's artifact." if 'needs' in spec else ""
        differs = bool(changed) or REMOTE.git_compared(now) != REMOTE.git_compared(frozen)
        new = REMOTE.check_start(differs, frozen, now, changed, [p for p in tracked if p not in named], hint=hint)
        self.assertEqual(new is not None, differs)
        if differs:
            self.assertEqual(new, old)
        return new

    def test_the_same_facts_name_the_same_changes(self):
        spec = {'git': {'frozen': git()}, 'inputs': [{'path': '/w/a'}]}
        self.assertIsNone(self.check(spec, git(), git(), [], []))
        self.assertEqual(self.check(spec, git(), git(head=OTHER), [], []),
                         'Guarded inputs changed while queued (the Git commit); command was not started.')
        self.assertEqual(self.check(spec, git(), git(), ['/w/c'], ['/w/a (its content changed)']),
                         'Guarded inputs changed while queued (/w/a (its content changed), /w/c); command was not started.')
        # A tracked file that is also a frozen input is no extra change; one
        # that is not is named after the input's own change. The tracked files
        # alone never refuse a start: the old predicate did not look at them.
        self.assertIsNone(self.check(spec, git(), git(), ['/w/a'], []))
        self.assertIsNone(self.check(spec, git(), git(), ['/w/a', '/w/b'], []))
        self.assertEqual(self.check(spec, git(), git(), ['/w/a', '/w/b'], ['/w/a (its content changed)']),
                         'Guarded inputs changed while queued (/w/a (its content changed), /w/b); '
                         'command was not started.')

    def test_a_stage_gets_the_hint_and_a_plain_job_does_not(self):
        stage = {'git': {'frozen': git()}, 'inputs': [], 'needs': ['a']}
        plain = {'git': {'frozen': git()}, 'inputs': []}
        self.assertTrue(self.check(stage, git(), git(status=OTHER), [], []).endswith(HINT))
        self.assertFalse(self.check(plain, git(), git(status=OTHER), [], []).endswith('artifact.'))

    def test_a_guarded_path_scope_is_compared_by_object(self):
        before = git(paths=[{'path': 'src', 'object': SHA, 'type': 'tree'}])
        moved = git(head=OTHER, paths=[{'path': 'src', 'object': SHA, 'type': 'tree'}])
        under = git(head=OTHER, paths=[{'path': 'src', 'object': OTHER, 'type': 'tree'}])
        spec = {'git': {'frozen': before}, 'inputs': []}
        self.assertIsNone(self.check(spec, before, moved, [], []))
        self.assertEqual(self.check(spec, before, under, [], []),
                         'Guarded inputs changed while queued (the committed content of guarded path src); '
                         'command was not started.')

    def test_a_frozen_tree_that_is_gone_now_is_the_git_commit(self):
        spec = {'git': {'frozen': None}, 'inputs': []}
        self.assertEqual(self.check(spec, None, git(), [], []),
                         'Guarded inputs changed while queued (the Git commit); command was not started.')


class BothEnds(unittest.TestCase):
    """The copies carry the same rule: the same facts get the same answer."""

    def test_the_two_copies_answer_alike(self):
        cases = [
            (git(), git()),
            (git(), git(head=OTHER)),
            (git(), git(status=OTHER)),
            (git(paths=[{'path': 'src', 'object': SHA, 'type': 'tree'}]),
             git(head=OTHER, status=OTHER, paths=[{'path': 'src', 'object': OTHER, 'type': 'tree'}])),
            (None, None),
            (None, git()),
        ]
        for frozen, now in cases:
            for changed, tracked, resume in (([], [], False), (['/w/a'], [], False), (['/w/a'], ['/w/b'], True)):
                self.assertEqual(HOST.check_start(True, frozen, now, changed, tracked, resume, HINT),
                                 REMOTE.check_start(True, frozen, now, changed, tracked, resume, HINT))
                # The same items with no verdict are not a refusal.
                self.assertIsNone(HOST.check_start(False, frozen, now, changed, tracked, resume, HINT))
                self.assertIsNone(REMOTE.check_start(False, frozen, now, changed, tracked, resume, HINT))

    def test_the_region_is_one_text(self):
        self.assertTrue(callable(HOST.check_start) and callable(REMOTE.check_start))
        self.assertEqual(HOST.check_start.__code__.co_code, REMOTE.check_start.__code__.co_code)
        self.assertEqual(RULES.check_start.__code__.co_consts, REMOTE.check_start.__code__.co_consts)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]])
