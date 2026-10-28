"""Tests of RISK.md: the R0 and R2 globs that set the review level of a PR.

    uv run --no-project --with pyyaml --with pytest -- python -m pytest -q .github/scripts

A glob that matches no file loses its level with no error, and an R2 glob over an R0 file misleads.
An R0 file that .github/risk.yml rates as docs gets the lowest CI tier.
The globs follow the rules of risk_tier.matches.
"""

import sys
from pathlib import Path

import pytest
import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))

import risk_tier as rt  # noqa: E402

GLOBS = yaml.safe_load((ROOT / "RISK.md").read_text(encoding="utf-8").split("---\n")[1])
FILES = rt._git("-C", str(ROOT), "ls-files").splitlines()
RULES = rt.load_rules(str(HERE.parent / "risk.yml"))


def test_front_matter_lists_r0_and_r2():
    assert set(GLOBS) == {"R0", "R2"}


@pytest.mark.parametrize("level,glob", [(level, g) for level, globs in GLOBS.items() for g in globs])
def test_each_glob_matches_a_file(level, glob):
    assert any(rt.matches(path, [glob]) for path in FILES), \
        f"{level} glob {glob} matches no file ({{, [ and ! are not supported)"


def test_no_file_is_r0_and_r2():
    both = [path for path in FILES if rt.matches(path, GLOBS["R0"]) and rt.matches(path, GLOBS["R2"])]
    assert not both, f"in R0 and R2: {both}"


def test_no_r0_file_is_docs_in_risk_yml():
    # risk.yml rates a docs file T0 unless hard or soft lists it.
    low = [path for path in FILES if rt.matches(path, GLOBS["R0"])
           and rt.is_docs(rt.FileChange(path=path, status="M", added=[], removed=[]), RULES)
           and not rt.matches(path, RULES["hard"] + RULES["soft"])]
    assert not low, f"R0 in RISK.md, docs in .github/risk.yml: {low}"
