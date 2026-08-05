from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import HTTPException

from routers.barcode import lookup_barcode


class FakeUser:
    id = "test-user"


def _fake_request():
    return MagicMock()


def _mock_response(status_code=200, json_data=None):
    response = MagicMock()
    response.status_code = status_code
    response.json = MagicMock(return_value=json_data or {})
    return response


def _patch_client(response=None, side_effect=None):
    mock_client = AsyncMock()
    if side_effect:
        mock_client.get.side_effect = side_effect
    else:
        mock_client.get.return_value = response
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = False
    # The actual httpx.AsyncClient() construction now lives in
    # services/barcode_lookup.py (routers/barcode.py delegates to it — see
    # that module's own docstring for why: the same fetch/reshape logic is
    # shared with routers/discover.py's product search), so that's what
    # needs patching now, not routers.barcode itself.
    return patch("services.barcode_lookup.httpx.AsyncClient", return_value=mock_client)


async def _call(code):
    # lookup_barcode's signature grew a `response: Response` parameter
    # (required by every @limiter.limit(...) route in this app — see
    # routers/discover.py's docstring for the full explanation); a plain
    # MagicMock stands in for it here since these tests never touch it.
    return await lookup_barcode.__wrapped__(_fake_request(), MagicMock(), code, FakeUser())


@pytest.mark.asyncio
async def test_rejects_non_numeric_code_without_any_network_call():
    with _patch_client() as mock_ctor:
        with pytest.raises(HTTPException) as exc:
            await _call("not-a-barcode")
        assert exc.value.status_code == 422
        mock_ctor.assert_not_called()


@pytest.mark.asyncio
async def test_successful_lookup_maps_off_fields_to_scan_result_shape():
    off_response = {
        "status": 1,
        "product": {
            "product_name": "Test Bar",
            "nutriments": {
                "energy-kcal_100g": 450,
                "proteins_100g": 20,
                "carbohydrates_100g": 40,
                "fat_100g": 15,
            },
        },
    }
    with _patch_client(response=_mock_response(200, off_response)):
        result = await _call("5901234123457")
    assert result.food_name == "Test Bar"
    assert result.weight_g == 100.0
    assert result.calories == 450
    assert result.protein == 20
    assert result.carbs == 40
    assert result.fats == 15


@pytest.mark.asyncio
async def test_product_not_found_returns_404():
    with _patch_client(response=_mock_response(200, {"status": 0})):
        with pytest.raises(HTTPException) as exc:
            await _call("5901234123457")
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_incomplete_nutrition_data_returns_422():
    off_response = {
        "status": 1,
        "product": {"product_name": "Mystery Item", "nutriments": {"energy-kcal_100g": 450}},  # missing the rest
    }
    with _patch_client(response=_mock_response(200, off_response)):
        with pytest.raises(HTTPException) as exc:
            await _call("5901234123457")
    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_network_failure_returns_503_with_friendly_message():
    with _patch_client(side_effect=httpx.ConnectError("boom")):
        with pytest.raises(HTTPException) as exc:
            await _call("5901234123457")
    assert exc.value.status_code == 503
    assert "AI photo scan or manual entry" in exc.value.detail


@pytest.mark.asyncio
async def test_upstream_server_error_returns_503():
    with _patch_client(response=_mock_response(500, {})):
        with pytest.raises(HTTPException) as exc:
            await _call("5901234123457")
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_non_json_response_returns_503_instead_of_crashing():
    response = _mock_response(200)
    response.json = MagicMock(side_effect=ValueError("not json"))
    with _patch_client(response=response):
        with pytest.raises(HTTPException) as exc:
            await _call("5901234123457")
    assert exc.value.status_code == 503
