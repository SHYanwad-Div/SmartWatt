"""Smart Watt v2 application entry point."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import auth, db
from .api.routes import compat, router
from .config import ROOT, settings
from .hub import hub
from .ingest.pipeline import pipeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("smartwatt")

FRONTEND_DIST = ROOT / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.connect()
    auth.seed_default_users()
    hub.bind_loop(asyncio.get_running_loop())
    pipeline.start()
    log.info("Smart Watt v2 ready  |  source=%s  |  http://localhost:%d",
             settings.source, settings.port)
    if not FRONTEND_DIST.exists():
        log.warning("frontend/dist not found - run 'npm run build' in frontend/ "
                    "to serve the dashboard from this server")
    yield
    pipeline.stop()


app = FastAPI(
    title="Smart Watt v2",
    description="IoT energy consumption monitoring with NILM, forecasting, "
                "slab billing, alerts and appliance control.",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # LAN demo; tighten for a real deployment
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")
# The Phase-I Node service exposed /mock_reading and /health at the root. Only
# those are mirrored there; everything else stays under /api so the dashboard's
# own routes (/settings, /reports...) are never shadowed by API handlers.
app.include_router(compat)


if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        """Serve the built SPA, letting the client router own unknown paths."""
        # A mistyped API path must stay a JSON 404, not quietly become index.html.
        if full_path == "api" or full_path.startswith(("api/", "docs", "openapi.json")):
            raise HTTPException(status_code=404, detail="Not Found")
        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file() and candidate.name != "index.html":
            return FileResponse(candidate)
        # The shell must be revalidated on every load so a rebuild's new hashed
        # bundle is picked up; the hashed assets under /assets can cache forever.
        return FileResponse(FRONTEND_DIST / "index.html", headers={"Cache-Control": "no-cache"})


def main() -> None:
    import uvicorn
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
