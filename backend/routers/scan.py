from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from slowapi import Limiter

from ..auth import get_current_user, rate_limit_key
from ..models import ScanResult
from ..services.gemini_service import InvalidFoodInputError, analyze_food_image

router = APIRouter(prefix="/scan", tags=["scan"])
limiter = Limiter(key_func=rate_limit_key)

ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB


@router.post("", response_model=ScanResult)
@limiter.limit("10/minute")
async def scan_food(
    request: Request,
    image: UploadFile = File(...),
    context_text: str = Form(default=""),
    user=Depends(get_current_user),
):
    if image.content_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=415, detail="Unsupported image type")

    image_bytes = await image.read()
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 8MB)")

    # context_text is free user input — it is treated as untrusted data inside
    # gemini_service, never concatenated into the system prompt itself.
    try:
        result = await analyze_food_image(image_bytes, image.content_type, context_text)
    except InvalidFoodInputError:
        raise HTTPException(
            status_code=422,
            detail="Couldn't identify food in that image. Try a clearer photo of your plate.",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return result
