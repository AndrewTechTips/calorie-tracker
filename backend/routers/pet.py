from fastapi import APIRouter, Depends

from auth import get_current_user
from database import get_supabase
from models import PetStateResponse
from services import pet_service

router = APIRouter(prefix="/pet", tags=["pet"])


@router.get("/state", response_model=PetStateResponse)
async def get_pet_state(user=Depends(get_current_user)):
    """Ollie's persistent health. `hearts` is read-only from the frontend's
    perspective — it's only ever written by services/pet_scheduler.py's daily
    sweep, judged against this user's own real daily_logs/water_logs, never
    by a direct client write. Hunger/hydration meters aren't served here at
    all: the frontend computes those live from data it already has loaded
    (today's calories vs. target, today's water total vs. target) — see
    CLAUDE.md's Ollie section for why."""
    supabase = get_supabase()
    state = await pet_service.get_or_create_pet_state(supabase, user.id)
    hearts = state["hearts"]
    return {"hearts": hearts, "mood": pet_service.mood_for_hearts(hearts), "max_hearts": pet_service.MAX_HEARTS}
