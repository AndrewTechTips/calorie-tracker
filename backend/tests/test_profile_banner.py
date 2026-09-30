"""profiles.profile_banner — the Settings profile-card cover.

The field accepts a bundled preset id or the user's own photo, and nothing
else. These tests pin that contract at the one place it is enforced
(models.is_valid_profile_banner, called from PUT /targets before the database
is touched) and the unmigrated-column fallback the rest of the profile relies
on."""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from postgrest.exceptions import APIError

from models import PROFILE_BANNER_PRESETS, TargetsUpdate, is_valid_profile_banner
from routers.targets import update_targets
from tests.test_targets import FakeUser, _chain, _result

# A real (tiny) base64 JPEG body is not needed — the check is on shape, and
# the frontend is the only thing that ever produces these.
_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJ=="


def _payload(banner):
    return TargetsUpdate(
        daily_calories=2200, daily_protein=150, daily_carbs=250, daily_fats=70, daily_water_ml=3000, profile_banner=banner
    )


@pytest.mark.parametrize("preset", sorted(PROFILE_BANNER_PRESETS))
def test_every_bundled_preset_is_accepted(preset):
    assert is_valid_profile_banner(f"preset:{preset}")


@pytest.mark.parametrize(
    "value",
    [
        "",  # clears back to the default cover
        _JPEG,
        "data:image/png;base64,iVBORw0KGgo=",
        "data:image/webp;base64,UklGRg==",
    ],
)
def test_accepted_shapes(value):
    assert is_valid_profile_banner(value)


@pytest.mark.parametrize(
    "value",
    [
        "preset:unknown",
        "preset:",
        "ember",  # a bare id without the prefix
        "https://example.com/cover.jpg",
        "javascript:alert(1)",
        # SVG is refused on purpose: a user-supplied SVG is a document that can
        # carry script and external references.
        "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        "data:text/html;base64,PGgxPg==",
        "data:image/jpeg;base64,not base64!",
        _JPEG + '")',  # anything that tries to break out of a url()/attribute
        " preset:ember",
    ],
)
def test_rejected_shapes(value):
    assert not is_valid_profile_banner(value)


async def test_invalid_banner_is_refused_before_the_database_is_touched():
    get_supabase = MagicMock(side_effect=AssertionError("must not reach the database"))
    with patch("routers.targets.get_supabase", get_supabase):
        with pytest.raises(HTTPException) as exc:
            await update_targets(_payload("https://example.com/x.png"), FakeUser())
    assert exc.value.status_code == 422
    get_supabase.assert_not_called()


async def test_valid_banner_is_written():
    table = _chain([_result([{"id": "test-user", "profile_banner": "preset:aurora"}])])
    supabase = MagicMock()
    supabase.table.return_value = table

    with patch("routers.targets.get_supabase", return_value=supabase):
        result = await update_targets(_payload("preset:aurora"), FakeUser())

    assert table.update.call_args[0][0]["profile_banner"] == "preset:aurora"
    assert result["profile_banner"] == "preset:aurora"


async def test_other_saves_never_overwrite_the_banner():
    """A targets/name/avatar save sends no profile_banner at all (the frontend's
    currentTargetsPayload() never includes it), and exclude_none must keep it
    out of the update — otherwise every settings save would reset the cover."""
    table = _chain([_result([{"id": "test-user"}])])
    supabase = MagicMock()
    supabase.table.return_value = table

    with patch("routers.targets.get_supabase", return_value=supabase):
        await update_targets(_payload(None), FakeUser())

    assert "profile_banner" not in table.update.call_args[0][0]


async def test_unmigrated_banner_column_does_not_fail_the_save():
    missing = APIError({"code": "42703", "message": "column profiles.profile_banner does not exist"})
    table = _chain([missing, _result([{"id": "test-user"}])])
    supabase = MagicMock()
    supabase.table.return_value = table

    with patch("routers.targets.get_supabase", return_value=supabase):
        result = await update_targets(_payload("preset:grove"), FakeUser())

    assert result["id"] == "test-user"
    assert "profile_banner" in table.update.call_args_list[0][0][0]
    assert "profile_banner" not in table.update.call_args_list[1][0][0]
