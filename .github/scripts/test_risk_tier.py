"""Tests of .github/scripts/risk_tier.py: the deterministic tier rules.

    uv run --no-project --with pyyaml --with pytest -- python -m pytest -q .github/scripts

Pure: no git, no network (the git part has one test on a temporary repo, marked `git`).
"""

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import risk_tier as rt  # noqa: E402

RULES = rt.load_rules(str(HERE.parent / "risk.yml"))


def f(path, added=(), removed=(), status="M", old_path=None):
    return rt.FileChange(path=path, status=status, added=list(added), removed=list(removed), old_path=old_path)


def tier(*files, title="", branch="", body="", read=None, automerge="", checks=None, head_sha="",
         comments=None, reviews=None):
    change = rt.Change(files=list(files), title=title, branch=branch, body=body,
                       read=read or (lambda p, s: None), automerge=automerge,
                       checks=checks, comments=comments, reviews=reviews, head_sha=head_sha)
    return rt.classify(change, RULES)


def manifests(**sides):
    """read() for base/head manifests: manifests(**{"base:path": text, "head:path": text})."""
    table = {tuple(k.split(":", 1)): v for k, v in sides.items()}
    return lambda path, side: table.get((side, path))


# ---------------------------------------------------------------- globs


@pytest.mark.parametrize("path,pattern,ok", [
    ("README.md", "*.md", True),
    ("docs/usage.mdx", "*.mdx", True),
    ("docs/a/b.png", "docs/**", True),
    ("skills/x/SKILL.md", "skills/**", True),
    ("src/kb/redact.py", "src/kb/redact.py", True),
    ("src/kb/redact.py.bak", "src/kb/redact.py", False),
    (".github/workflows/publish-npm.yml", "**/publish*.yml", True),
    ("a/b/gitleaks_fetch.py", "**/gitleaks_fetch.py", True),
    ("gitleaks_fetch.py", "**/gitleaks_fetch.py", True),
    ("tests/version.check.mjs", "tests/*.check.mjs", True),
    ("tests/sub/x.check.mjs", "tests/*.check.mjs", False),
])
def test_glob(path, pattern, ok):
    assert rt.matches(path, [pattern]) is ok


# ---------------------------------------------------------------- T0 / T1


def test_docs_only_is_t0():
    r = tier(f("README.md", ["new line"]), f("docs/usage.mdx", ["x"], ["y"]))
    assert r["tier"] == "T0" and r["label"] == "risk:t0"


def test_test_only_that_adds_assertions_is_t0():
    r = tier(f("tests/test_new.py", ["def test_x():", "    assert 1 == 1"], status="A"))
    assert r["tier"] == "T0"


def test_test_change_that_removes_assertions_is_t1():
    r = tier(f("tests/test_old.py", ["    pass"], ["    assert a == b", "    assert c"]))
    assert r["tier"] == "T1" and r["reasons"][0]["rule"] == "assertions-removed"


def test_deleted_test_file_is_t1():
    assert tier(f("tests/test_old.py", [], ["assert x"], status="D"))["tier"] == "T1"


def test_model_facing_markdown_is_not_docs():
    folder = next(p[:-3] for p in RULES["not_docs"] if p.endswith("/**") and "*" not in p[:-3])
    assert tier(f(f"{folder}/x/SKILL.md", ["new rule"]))["tier"] == "T1"
    assert tier(f("AGENTS.md", ["x"]))["tier"] == "T1"


def test_source_change_is_t1():
    assert tier(f("src/kb/sync.py", ["x = 1"], ["x = 2"]))["tier"] == "T1"


def test_empty_change_is_t1():
    assert tier()["tier"] == "T1"


def test_ci_check_script_is_not_a_test():
    if "tests/*.check.mjs" not in (RULES.get("not_tests") or []):
        pytest.skip("this repo has no check scripts under tests/")
    assert tier(f("tests/version.check.mjs", ["x"], ["y"]))["tier"] == "T1"


# ---------------------------------------------------------------- plugin versions and dependencies


PLUGIN = next(iter(RULES.get("plugin_manifests") or []), None)
PYPROJECT = next(iter((RULES.get("dependency_manifests") or {}).get("python") or []), None)


@pytest.mark.parametrize("old,new,expected", [
    ("0.2.3", "0.2.4", "T1"),
    ("0.2.3", "0.3.0", "T1"),
    ("0.11.4", "1.0.0", "T2-hard"),
    ("1.4.0", "2.0.0", "T2-hard"),
    ("0.2.3", "0.2.2", "T2-hard"),
])
def test_plugin_version_bumps(old, new, expected):
    if not PLUGIN:
        pytest.skip("this repo has no plugin manifest")
    read = manifests(**{f"base:{PLUGIN}": json.dumps({"version": old}), f"head:{PLUGIN}": json.dumps({"version": new})})
    assert tier(f(PLUGIN, ['"version": "x"'], ['"version": "y"']), read=read)["tier"] == expected


def test_new_runtime_npm_dependency_is_t2_hard():
    read = manifests(**{"base:package.json": json.dumps({"dependencies": {"a": "^1.0.0"}}),
                        "head:package.json": json.dumps({"dependencies": {"a": "^1.0.0", "b": "^2.0.0"}})})
    r = tier(f("package.json", ['"b": "^2.0.0"']), read=read)
    assert r["tier"] == "T2-hard" and r["reasons"][0]["rule"] == "new-runtime-dependency"


@pytest.mark.parametrize("old,new,expected", [
    ("^9.1.0", "^10.0.0", "T2-hard"),
    ("^0.6.2", "^0.7.0", "T2-hard"),
    ("^1.2.0", "^1.3.0", "T1"),
])
def test_runtime_npm_bumps(old, new, expected):
    read = manifests(**{"base:package.json": json.dumps({"dependencies": {"a": old}}),
                        "head:package.json": json.dumps({"dependencies": {"a": new}})})
    assert tier(f("package.json", ["x"], ["y"]), read=read)["tier"] == expected


def test_moved_manifest_compares_with_its_old_place():
    read = manifests(**{"base:old/package.json": json.dumps({"dependencies": {"a": "^1.0.0"}}),
                        "head:package.json": json.dumps({"dependencies": {"a": "^1.0.0"}})})
    r = tier(f("package.json", ["x"], status="R", old_path="old/package.json"), read=read)
    assert not any(x["rule"] == "new-runtime-dependency" for x in r["reasons"])


def test_dev_dependency_is_t1():
    read = manifests(**{"base:package.json": json.dumps({"devDependencies": {}}),
                        "head:package.json": json.dumps({"devDependencies": {"@types/node": "^24.0.0"}})})
    assert tier(f("package.json", ["x"]), read=read)["tier"] == "T1"


def test_new_python_runtime_dependency_is_t2_hard():
    base = '[project]\nname = "x"\ndependencies = ["pyyaml>=6"]\n'
    head = '[project]\nname = "x"\ndependencies = ["pyyaml>=6", "requests>=2"]\n'
    if not PYPROJECT:
        pytest.skip("this repo has no Python manifest")
    read = manifests(**{f"base:{PYPROJECT}": base, f"head:{PYPROJECT}": head})
    assert tier(f(PYPROJECT, ['"requests>=2"']), read=read)["tier"] == "T2-hard"


def test_publish_on_version(monkeypatch):
    monkeypatch.setitem(RULES, "publish_on_version", ["package.json"])
    read = manifests(**{"base:package.json": json.dumps({"version": "3.0.0"}),
                        "head:package.json": json.dumps({"version": "3.1.0"})})
    r = tier(f("package.json", ["x"], ["y"]), read=read)
    assert r["tier"] == "T2-hard" and any(x["rule"] == "publish-version" for x in r["reasons"])


# ---------------------------------------------------------------- T2 paths and workflows


@pytest.mark.parametrize("path", [".github/risk.yml", "LICENSE", ".gitleaks.toml", ".githooks/pre-commit",
                                  ".github/workflows/review.yml", ".github/workflows/risk.yml",
                                  ".github/scripts/risk_tier.py", "CODEOWNERS"])
def test_hard_paths(path):
    assert tier(f(path, ["x"]))["tier"] == "T2-hard"


def test_soft_paths():
    soft = RULES.get("soft") or []
    if not soft:
        pytest.skip("this repo lists no sensitive files")
    path = soft[0].replace("**/", "").replace("/**", "/x")
    assert tier(f(path, ["x"]))["tier"] == "T2-soft"


def test_soft_content(monkeypatch):
    monkeypatch.setitem(RULES, "soft_content", [{"paths": ["src/**"], "pattern": "secret|redact"}])
    r = tier(f("src/x/page.ts", ["  return redactAll(text)"], ["  return text"]))
    assert r["tier"] == "T2-soft" and r["reasons"][0]["rule"] == "sensitive-code"
    assert tier(f("src/x/page.ts", ["  return a + b"]))["tier"] == "T1"
    assert tier(f("lib/x.ts", ["secret"]))["tier"] == "T1"   # outside the paths
    monkeypatch.setitem(RULES, "soft_content", [{"pattern": "redact"}])
    assert tier(f("tests/test_x.py", ["    assert redact(x)"]))["tier"] == "T0"   # tests never match


def test_additive_workflow_edit_is_t2_soft():
    r = tier(f(".github/workflows/test.yml", ["  lint:", "    runs-on: ubuntu-latest", "      - run: make lint"]))
    assert r["tier"] == "T2-soft"


def test_pinned_version_bump_is_t2_soft():
    r = tier(f(".github/workflows/test.yml", ["      - uses: actions/checkout@v5"], ["      - uses: actions/checkout@v4"]))
    assert r["tier"] == "T2-soft"


def test_removed_step_is_t2_hard():
    r = tier(f(".github/workflows/test.yml", [], ["      - run: node tests/version.check.mjs"]))
    assert r["tier"] == "T2-hard" and r["reasons"][0]["rule"] == "workflow-weakened"


def test_changed_run_command_is_t2_hard():
    r = tier(f(".github/workflows/test.yml", ["      - run: echo ok"], ["      - run: scripts/test --all"]))
    assert r["tier"] == "T2-hard"


@pytest.mark.parametrize("line", ["permissions:", "  contents: write", "    env: { T: ${{ secrets.X }} }",
                                  "  pull_request_target:", "on:"])
def test_workflow_permissions_secrets_triggers_are_t2_hard(line):
    assert tier(f(".github/workflows/test.yml", [line]))["tier"] == "T2-hard"


def test_deleted_workflow_is_t2_hard():
    assert tier(f(".github/workflows/test.yml", [], ["x"], status="D"))["tier"] == "T2-hard"


def test_mass_deletion_and_deleted_source():
    r = tier(f("src/big.py", [], ["x = 1"] * 1200, status="D"))
    rules = {x["rule"] for x in r["reasons"]}
    assert r["tier"] == "T2-hard" and {"mass-deletion", "deleted-source"} <= rules


def test_size_limits():
    many = [f(f"src/m{i}.py", ["x"]) for i in range(41)]
    assert tier(*many)["tier"] == "T2-hard"
    assert tier(f("src/a.py", ["x"] * 1501))["tier"] == "T2-hard"
    assert tier(f("uv.lock", ["x"] * 5000), f("src/a.py", ["y"]))["tier"] == "T1"   # lockfiles do not count


def test_history_rewrite_request():
    assert tier(f("src/a.py", ["x"]), title="Rewrite history to drop a file")["tier"] == "T2-hard"
    assert tier(f("src/a.py", ["x"]), branch="fix/force-push-main")["tier"] == "T2-hard"
    assert tier(f("src/a.py", ["x"]), body="/verify: a force push was denied.")["tier"] == "T1"


def test_kill_switch_raises_everything():
    r = tier(f("README.md", ["x"]), automerge="off")
    assert r["tier"] == "T2-hard" and any(x["rule"] == "kill-switch" for x in r["reasons"])
    assert tier(f("README.md", ["x"]), automerge="on")["tier"] == "T0"


# ---------------------------------------------------------------- HOLD


def test_forbidden_name_is_hold(monkeypatch):
    # A made-up name: the real ones are hashes in risk.yml, so this public repo never spells them.
    monkeypatch.setitem(RULES, "hold", {**RULES["hold"], "forbidden_names_sha256": [hashlib.sha256(b"acmebrand").hexdigest()]})
    assert tier(f("README.md", ["Install the AcmeBrand plugin"]))["tier"] == "HOLD"
    assert tier(f("README.md", ["see acme-brand_tools"]))["tier"] == "HOLD"
    assert tier(f("plugins/acmebrand-x/plugin.json", ["{}"], status="A"))["tier"] == "HOLD"
    assert tier(f("cfg.yaml", ["checkout: ~/Repositories/acmebrand/app"]))["tier"] == "HOLD"
    assert tier(f("src/a.py", [], ["# AcmeBrand"]))["tier"] == "T1"   # removing a mention is fine
    assert tier(f("src/a.py", ["# the acme brand"]))["tier"] != "HOLD"   # words a space separates do not join
    assert tier(f("src/a.py", ["# acmebrandnew"]))["tier"] != "HOLD"


def test_rules_hold_the_names_as_hashes_only():
    hashes = RULES["hold"]["forbidden_names_sha256"]
    assert hashes and all(re.fullmatch(r"[0-9a-f]{64}", h) for h in hashes)


def test_comment_pruning_by_title_is_hold():
    assert tier(f("src/a.py", ["x"]), title="Prune redundant comments")["tier"] == "HOLD"
    assert tier(f("src/a.py", ["x"]), branch="claude/remove-obvious-comments")["tier"] == "HOLD"


def test_comment_pruning_by_diff_is_hold():
    removed = [f"    # comment {i}" for i in range(30)] + ["x = 1"]
    assert tier(f("src/a.py", ["x = 2"], removed))["tier"] == "HOLD"


def test_doc_edits_are_not_comment_pruning():
    removed = [f"# Heading {i}" for i in range(30)]
    assert tier(f("docs/a.mdx", [], removed))["tier"] == "T0"


# ---------------------------------------------------------------- the rules file and git


def test_parse_diff():
    diff = "\n".join([
        "diff --git a/a.py b/a.py", "index 1..2 100644", "--- a/a.py", "+++ b/a.py", "@@ -1 +1 @@", "-old", "+new",
        "diff --git a/n.md b/n.md", "new file mode 100644", "--- /dev/null", "+++ b/n.md", "@@ -0,0 +1 @@", "+hi",
        "diff --git a/d.py b/d.py", "deleted file mode 100644", "--- a/d.py", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
        "diff --git a/o.py b/r.py", "similarity index 90%", "rename from o.py", "rename to r.py",
        "diff --git a/i.png b/i.png", "Binary files a/i.png and b/i.png differ",
    ])
    files = {x.path: x for x in rt.parse_diff(diff)}
    assert files["a.py"].added == ["new"] and files["a.py"].removed == ["old"]
    assert files["n.md"].status == "A" and files["d.py"].status == "D"
    assert files["r.py"].status == "R" and files["r.py"].old_path == "o.py"
    assert files["i.png"].binary


def test_markdown_escapes_pipes():
    r = tier(f("LICENSE|x", ["x"], status="A"), f("LICENSE", ["x"]))
    r["reasons"][0]["detail"] = "a|b"
    assert "a\\|b" in rt.markdown(r) and "| a|b |" not in rt.markdown(r)


def test_cli_on_a_git_repo(tmp_path):
    def git(*args):
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=tmp_path, check=True,
                       capture_output=True)
    env_rules = tmp_path / "rules.yml"
    env_rules.write_text((HERE.parent / "risk.yml").read_text(encoding="utf-8"), encoding="utf-8")
    git("init", "-q", "-b", "main")
    (tmp_path / "README.md").write_text("a\n")
    git("add", "."); git("commit", "-qm", "base")
    git("checkout", "-qb", "pr")
    (tmp_path / "README.md").write_text("a\nb\n")
    git("commit", "-qam", "docs")
    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        out = tmp_path / "out.json"
        assert rt.main(["--rules", str(env_rules), "--base", "main", "--head", "pr", "--json", str(out)]) == 0
    finally:
        os.chdir(cwd)
    assert json.loads(out.read_text())["tier"] == "T0"


# ---------------------------------------------------------------- ways around the tier


def _pr_repo(tmp_path, base_files, pr_files, rules_text=None):
    """A repo with `base_files` on main and `pr_files` changed on branch pr; the tier of pr."""
    def git(*args):
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=tmp_path, check=True,
                       capture_output=True)

    def write(files):
        for name, text in files.items():
            p = tmp_path / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")

    rules = tmp_path.parent / f"{tmp_path.name}-rules.yml"
    rules.write_text(rules_text or (HERE.parent / "risk.yml").read_text(encoding="utf-8"), encoding="utf-8")
    git("init", "-q", "-b", "main")
    write(base_files)
    git("add", "-A"); git("commit", "-qm", "base")
    git("checkout", "-qb", "pr")
    write(pr_files)
    git("add", "-A"); git("commit", "-qm", "pr")
    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        out = tmp_path.parent / f"{tmp_path.name}-out.json"
        assert rt.main(["--rules", str(rules), "--base", "main", "--head", "pr", "--json", str(out)]) == 0
    finally:
        os.chdir(cwd)
    return json.loads(out.read_text())


@pytest.mark.parametrize("name", [".github/workflows/ré.yml", '.github/workflows/a"b.yml',
                                  ".github/workflows/a\tb.yml"])
def test_a_workflow_with_a_quoted_name_is_still_a_workflow(tmp_path, name):
    # git quotes such a path in the diff header ("a/...") and the parser lost it, so it was T1
    r = _pr_repo(tmp_path, {"README.md": "a\n"},
                 {name: "on: pull_request_target\njobs: {}\n"})
    assert r["tier"] == "T2-hard"


def test_a_path_with_space_b_slash_is_read_whole(tmp_path):
    # "diff --git a/hooks/x b/docs/y.md b/hooks/x b/docs/y.md" read as docs/y.md, so it was T0
    r = _pr_repo(tmp_path, {"README.md": "a\n"}, {"hooks/x b/docs/y.md": "rules\n"})
    assert r["tier"] == "T1"


def test_gitattributes_cannot_hide_added_lines(tmp_path):
    # `-diff` made git print "Binary files differ", so the HOLD scan saw no added line
    rules = (HERE.parent / "risk.yml").read_text(encoding="utf-8").replace(
        "forbidden_text: []", 'forbidden_text: ["vendorx"]')
    r = _pr_repo(tmp_path, {"hooks/gate.ts": "a\n"},
                 {".gitattributes": "*.ts -diff\n", "hooks/gate.ts": "a\ninstall vendorx\n"}, rules)
    assert r["tier"] == "HOLD"


def test_a_changed_assertion_is_t1():
    # one assertion out, one weaker one in: the net count was 0, so it was T0
    r = tier(f("tests/gate.test.ts", ["  expect(true).toBe(true)"], ["  expect(deny(cmd)).toBe(true)"]))
    assert r["tier"] == "T1" and r["reasons"][0]["rule"] == "assertions-removed"


@pytest.mark.parametrize("line", ["test.skip('denies', () => {", "describe.only('gate', () => {",
                                  "  it.todo('denies')", "@pytest.mark.skip", "xit('denies', () => {"])
def test_a_skipped_test_is_t1(line):
    r = tier(f("tests/gate.test.ts", [line, "  expect(1).toBe(1)"]))
    assert r["tier"] == "T1" and r["reasons"][0]["rule"] == "tests-skipped"


def test_a_diff_that_git_lists_otherwise_is_t2_hard():
    change = rt.Change(files=[f("README.md", ["x"])], problem="git lists 2 changed files and its diff shows 1")
    r = rt.classify(change, RULES)
    assert r["tier"] == "T2-hard" and r["reasons"][0]["rule"] == "unreadable-diff"


def test_parse_name_status_reads_raw_paths():
    out = rt.parse_name_status("M\0a b/c.md\0R087\0old.py\0new.py\0A\0ré\t.yml\0")
    assert out == [("M", None, "a b/c.md"), ("R", "old.py", "new.py"), ("A", None, "ré\t.yml")]


# ---------------------------------------------------------------- reviewer config and the Greptile check


@pytest.mark.parametrize("path", ["greptile.json", "src/greptile.json", ".greptile/config.json",
                                  ".greptile/a/b.yml", ".coderabbit.yaml", ".coderabbit.yml",
                                  "nested/.coderabbit.yaml"])
def test_reviewer_config_is_t2_hard(path):
    assert tier(f(path, ["x"]))["tier"] == "T2-hard"


def _greptile(sha="abc", status="completed", conclusion="success", slug="greptile-apps", name="Greptile Review", **extra):
    return {"name": name, "status": status, "conclusion": conclusion, "head_sha": sha,
            "app": {"slug": slug}, **extra}


def _summary(sha="abc", score=5, updated_at="2026-10-19T00:00:00Z", login="greptile-apps[bot]", type_="Bot"):
    body = ("<!-- greptile_summary -->\n"
            f"<h2>Confidence Score: {score}/5</h2>\n"
            f'Last reviewed commit: ["title"](https://github.com/example/repo/commit/{sha})\n')
    return {"user": {"login": login, "type": type_}, "body": body,
            "created_at": updated_at, "updated_at": updated_at}


def _inline(sha="abc", badge="P1", login="greptile-apps[bot]", type_="Bot"):
    body = (f'<a href="#"><img alt="{badge}" src="https://greptile-static-assets.s3.amazonaws.com/badges/'
            f'{badge.lower()}.svg?v=9" align="top"></a> **finding**\n')
    return {"user": {"login": login, "type": type_}, "commit_id": sha, "body": body}


def _passed(**kw):
    """A docs change plus a full Greptile pass, with overrides."""
    sha = kw.pop("sha", "abc")
    return dict(checks=kw.pop("checks", [_greptile(sha=sha)]),
                comments=kw.pop("comments", [_summary(sha)]),
                reviews=kw.pop("reviews", []), head_sha=sha)


def test_a_passing_greptile_review_does_not_lower_the_tier():
    ok = _passed()
    assert tier(f("README.md", ["x"]), **ok)["tier"] == "T0"
    assert tier(f("src/a.py", ["x"]), **ok)["tier"] == "T1"
    soft = tier(f("runtime/runner.mjs", ["x"]), **ok)
    assert soft["tier"] == "T2-soft" and not any(x["rule"] == "reviewer-not-passed" for x in soft["reasons"])
    hard = tier(f(".github/risk.yml", ["x"]), **ok)
    assert hard["tier"] == "T2-hard"
    assert not any(x["rule"] == "reviewer-not-passed" for x in hard["reasons"])
    held = tier(f("src/a.py", ["x"]), title="Prune redundant comments", **ok)
    assert held["tier"] == "HOLD"


def test_a_failing_greptile_review_raises_one_step():
    checks = [_greptile(conclusion="failure")]
    docs = tier(f("README.md", ["x"]), checks=checks, head_sha="abc")
    assert docs["tier"] == "T1" and docs["reasons"][0]["rule"] == "reviewer-not-passed"
    assert tier(f("src/a.py", ["x"]), checks=checks, head_sha="abc")["tier"] == "T2-soft"
    assert tier(f("runtime/runner.mjs", ["x"]), checks=checks, head_sha="abc")["tier"] == "T2-hard"
    # capped at T2-hard: a failure does not turn it into HOLD
    assert tier(f(".github/risk.yml", ["x"]), checks=checks, head_sha="abc")["tier"] == "T2-hard"
    held = tier(f("src/a.py", ["x"]), title="Prune redundant comments", checks=checks, head_sha="abc")
    assert held["tier"] == "HOLD" and not any(x["rule"] == "reviewer-not-passed" for x in held["reasons"])


@pytest.mark.parametrize("checks", [
    [],
    [_greptile(conclusion="failure")],
    [_greptile(status="in_progress", conclusion=None)],
    [_greptile(sha="old")],
    [_greptile(slug="github-actions")],
    [_greptile(conclusion="stale")],
])
def test_a_greptile_check_that_did_not_pass_raises_t0_to_t1(checks):
    r = tier(f("README.md", ["x"]), checks=checks, head_sha="abc")
    assert r["tier"] == "T1" and r["reasons"][0]["rule"] == "reviewer-not-passed"


def test_a_missing_greptile_review_is_not_passed():
    assert tier(f("README.md", ["x"]), checks=[], head_sha="abc")["tier"] == "T1"
    # a label or a comment that says the review passed is not the check
    decoy = [_greptile(name="risk:t0", output={"summary": "Greptile Review passed", "text": "LGTM"})]
    assert tier(f("README.md", ["x"]), checks=decoy, head_sha="abc")["tier"] == "T1"


def test_a_greptile_review_from_the_wrong_app_is_not_passed():
    checks = [_greptile(slug="github-actions")]
    assert tier(f("README.md", ["x"]), checks=checks, head_sha="abc")["tier"] == "T1"
    assert tier(f("src/a.py", ["x"]), checks=checks, head_sha="abc")["tier"] == "T2-soft"


def test_a_greptile_review_on_an_old_sha_is_not_passed():
    checks = [_greptile(sha="old")]
    assert tier(f("README.md", ["x"]), checks=checks, comments=[_summary("old")], head_sha="abc")["tier"] == "T1"
    assert rt.review_passed(checks, "old", [_summary("old")], []) is True


def test_a_bad_checks_file_counts_as_not_passed(tmp_path):
    missing = tmp_path / "nope.json"
    broken = tmp_path / "broken.json"
    broken.write_text("{", encoding="utf-8")
    assert rt.load_checks(str(missing)) == []
    assert rt.load_checks(str(broken)) == []
    assert rt.load_comments(str(broken)) == []
    page = tmp_path / "page.json"
    page.write_text(json.dumps([{"check_runs": [_greptile()]}]), encoding="utf-8")
    assert rt.review_passed(rt.load_checks(str(page)), "abc", [_summary()], []) is True


# ---------------------------------------------------------------- Greptile pass rule: summary and inline comments


HEAD47 = "5075dbc6918a73c32ed780236d3812bd007318f7"
FIX = HERE / "fixtures"


def _pr47():
    return (json.loads((FIX / "pr47-summary.json").read_text(encoding="utf-8")),
            json.loads((FIX / "pr47-reviews.json").read_text(encoding="utf-8")))


def test_the_real_pr47_greptile_review_is_not_a_pass():
    # Check run on 5075dbc concluded success. The summary says 0/5 and the head has P1 comments.
    summary, reviews = _pr47()
    assert summary[0]["user"] == {"login": "greptile-apps[bot]", "type": "Bot"}
    assert "Confidence Score: 0/5" in summary[0]["body"]
    assert HEAD47 in summary[0]["body"]
    assert any(c["commit_id"] == HEAD47 and 'alt="P1"' in c["body"] for c in reviews)
    checks = [_greptile(sha=HEAD47)]
    assert rt.review_passed(checks, HEAD47, summary, reviews) is False
    got = tier(f("README.md", ["x"]), checks=checks, comments=summary, reviews=reviews, head_sha=HEAD47)
    assert got["tier"] == "T1" and got["reasons"][0]["rule"] == "reviewer-not-passed"
    # P1 badges inside the summary are not inline comments, so a 5/5 rewrite of this summary passes.
    clean = json.loads(json.dumps(summary))
    clean[0]["body"] = summary[0]["body"].replace("Confidence Score: 0/5", "Confidence Score: 5/5")
    assert rt.review_passed(checks, HEAD47, clean, []) is True


@pytest.mark.parametrize("score", [4, 5])
def test_a_high_confidence_summary_with_no_blocking_comment_passes(score):
    ok = _passed(comments=[_summary(score=score)])
    assert rt.review_passed(ok["checks"], ok["head_sha"], ok["comments"], ok["reviews"]) is True
    assert tier(f("README.md", ["x"]), **ok)["tier"] == "T0"


def test_a_confidence_score_of_3_is_not_a_pass():
    got = tier(f("README.md", ["x"]), **_passed(comments=[_summary(score=3)]))
    assert got["tier"] == "T1"


def test_a_summary_of_an_old_sha_is_not_a_pass():
    got = tier(f("README.md", ["x"]), **_passed(comments=[_summary("old")]))
    assert got["tier"] == "T1"


def test_a_missing_summary_is_not_a_pass():
    got = tier(f("README.md", ["x"]), **_passed(comments=[]))
    assert got["tier"] == "T1"


def test_an_unparseable_confidence_score_is_not_a_pass():
    comment = _summary()
    comment["body"] = comment["body"].replace("Confidence Score: 5/5", "Confidence Score: high/5")
    got = tier(f("README.md", ["x"]), **_passed(comments=[comment]))
    assert got["tier"] == "T1"


def test_a_p0_inline_comment_is_not_a_pass():
    got = tier(f("README.md", ["x"]), **_passed(reviews=[_inline(badge="P0")]))
    assert got["tier"] == "T1"


def test_a_p1_inline_comment_on_an_old_commit_does_not_block():
    ok = _passed(reviews=[_inline(sha="old")])
    assert rt.review_passed(ok["checks"], "abc", ok["comments"], ok["reviews"]) is True
    assert tier(f("README.md", ["x"]), **ok)["tier"] == "T0"
    # a P2 badge on this head is not P0 or P1
    assert rt.review_passed(ok["checks"], "abc", ok["comments"], [_inline(badge="P2")]) is True


def test_the_right_greptile_text_from_another_author_is_not_a_pass():
    foreign = _summary(login="octocat", type_="User")
    assert tier(f("README.md", ["x"]), **_passed(comments=[foreign]))["tier"] == "T1"
    # a P1 from someone else does not block a real Greptile pass
    ok = _passed(reviews=[_inline(login="octocat", type_="User")])
    assert tier(f("README.md", ["x"]), **ok)["tier"] == "T0"


def test_a_failed_check_with_a_good_comment_is_not_a_pass():
    got = tier(f("README.md", ["x"]), **_passed(checks=[_greptile(conclusion="failure")]))
    assert got["tier"] == "T1"


def test_the_latest_summary_is_the_one_that_counts():
    older = _summary(score=0, updated_at="2026-10-19T00:00:00Z")
    newer = _summary(score=4, updated_at="2026-10-19T01:00:00Z")
    assert rt.review_passed([_greptile()], "abc", [older, newer], []) is True
    fresh_low = _summary(score=1, updated_at="2026-10-19T02:00:00Z")
    assert rt.review_passed([_greptile()], "abc", [newer, fresh_low], []) is False


def test_pull_request_target_checkouts_keep_no_token():
    # The job token of a pull_request_target run can write, so no checkout there leaves it in the git config.
    for path in (HERE.parent / "workflows").glob("*.yml"):
        text = path.read_text(encoding="utf-8")
        if "pull_request_target" not in text:
            continue
        for name, job in yaml.safe_load(text)["jobs"].items():
            for step in job.get("steps", []):
                if str(step.get("uses", "")).startswith("actions/checkout@"):
                    assert (step.get("with") or {}).get("persist-credentials") is False, f"{path.name}: {name}"


def test_pull_request_target_workflows_have_no_secrets():
    workflows = HERE.parent / "workflows"
    review = workflows / "review.yml"
    assert not review.exists() or "secrets." not in review.read_text(encoding="utf-8")
    for path in workflows.glob("*.yml"):
        text = path.read_text(encoding="utf-8")
        if "pull_request_target" in text:
            assert "secrets." not in text, path.name
