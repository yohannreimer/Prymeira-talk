# Google Maps scraper in production

Deploy `swarm-stack.yml` as the separate Portainer stack
`prymeiratalk-google-maps`. It joins the existing Talk internal overlay network
and a dedicated egress network; no port is published. The Talk API service must
have `GOOGLE_MAPS_SCRAPER_URL=http://google-maps-scraper:8080`.

The image is pinned by digest and includes its Playwright driver and browser.
Keep `/opt` from being masked by a volume. The job data volume is local to
`srv1904129`, so update the placement and storage plan before moving the service
to another node. The scraper API has no authentication and must remain private.

Validate after deployment with a bounded search in the Leads UI. Check that
the scraper task is running, that the search reaches a completed or partial
state with real results, and that the Talk API readiness endpoint still responds.
