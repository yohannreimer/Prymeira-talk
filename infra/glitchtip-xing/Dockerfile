# The release uses 6.1.8 (not v6.1.8). Pin the verified official multiarch manifest.
FROM glitchtip/glitchtip:6.1.8@sha256:7e497103d3694e95fce232e83193cc2ef6865569314c66eb577b97c7c651008b
USER root
COPY xing_alerts /code/xing_alerts
COPY scripts /code/xing-alerts-scripts
# Dependencies already ship in this fixed official image. No installer at runtime.
RUN python -c "import aiohttp, cryptography; from importlib.metadata import version; assert version('mcp') == '1.27.0'" \
    && python /code/xing-alerts-scripts/install_extension.py \
    && python -m compileall -q /code/xing_alerts \
    && mkdir -p /var/lib/xing-alerts \
    && chown app:app /var/lib/xing-alerts \
    && chmod 700 /var/lib/xing-alerts
ENV XING_EVENTS_ENABLED=false
VOLUME ["/var/lib/xing-alerts"]
USER app:app
# Inherit upstream WORKDIR, CMD, ingest, static frontend, startup and embedded worker.
