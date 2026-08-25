from services.exercise_cache_service import _FUZZY_MATCH_THRESHOLD, _name_match_score


def test_literal_substring_scores_maximum():
    assert _name_match_score("bench press", "incline bench press") == 1.0


def test_word_order_independent():
    # "press bench" (backwards) still clears the threshold against "Bench
    # Press" — a plain substring check never could, since the words never
    # appear in that order in the real name.
    assert _name_match_score("press bench", "bench press") >= _FUZZY_MATCH_THRESHOLD


def test_single_typo_still_matches():
    # One mistyped character in "squat" shouldn't fail the whole query the
    # way the old all-or-nothing substring check did.
    assert _name_match_score("sqaut", "barbell back squat") >= _FUZZY_MATCH_THRESHOLD


def test_partial_word_still_matches():
    assert _name_match_score("curl", "dumbbell bicep curl") >= _FUZZY_MATCH_THRESHOLD


def test_unrelated_query_does_not_match():
    assert _name_match_score("deadlift", "seated cable row") < _FUZZY_MATCH_THRESHOLD


def test_empty_query_matches_everything():
    assert _name_match_score("", "anything") == 1.0
