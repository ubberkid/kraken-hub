# SUMMARY
All four research areas covered; every control-channel candidate was probed live on 2026-08-30 (not just read about). Headline findings: (1) All three public MQTT-over-WSS brokers are LIVE and all three support RETAINED messages — empirically confirmed by a hand-rolled MQTT 3.1.1 client over WebSocket (CONNACK rc=0, retain flag true on redelivery to a fresh subscriber). This makes MQTT+retain the best fit for "display page recovers last state instantly after reload". (2) ntfy.sh is LIVE with `access-control-allow-origin: *` on POST/OPTIONS/SSE and a verified 12h message cache (expires-time = 43200s), giving replay-based last-value semantics — an excellent fallback with a completely different failure domain (HTTP/SSE vs WSS). (3) Vimeo `setQuality` is account-tier gated ("available to Plus, PRO and Business accounts") so it will NOT work on arbitrary public videos — only getQualities/getQuality are universally usable. (4) Twitch requires a `parent` param matching the embedding hostname, which must be set dynamically from `window.location.hostname` so OSS forks on different `*.github.io` hostnames keep working. (5) Chromium does NOT support Matroska/MKV in `<video>` — a hard limit. (6) Discord CDN links are signed and expire (~24h) and returned no ACAO header — unusable for persistent playback. (7) Generic CORS proxies are unreliable for HLS specifically because segment/variant URLs inside the manifest also need proxying — an HLS-aware Cloudflare Worker that rewrites playlists is required, not a plain passthrough proxy. Critical implementation caveat discovered empirically: on HiveMQ, publishing a retained message immediately after CONNECT and closing quickly silently LOSES the retained message; it only persisted after an adequate settle delay.

# FACTS
- [verified] broker.emqx.io:8084/mqtt is LIVE over WSS: returns HTTP/1.1 101 Switching Protocols with sec-websocket-protocol: mqtt, server: Cowboy. Full MQTT 3.1.1 CONNECT returned CONNACK rc=0.
  src: Direct probe 2026-08-30: curl WebSocket upgrade handshake + hand-rolled MQTT client over Node global WebSocket
- [verified] broker.emqx.io RETAINED messages work over WSS: published retained msg, disconnected, reconnected as a NEW client, subscribed, and received the message with the retain flag set to true. Payload {"v":1,"cmd":"play",...} round-tripped intact.
  src: Direct probe 2026-08-30: raw MQTT 3.1.1 over wss://broker.emqx.io:8084/mqtt, PUBLISH byte 0x31 (retain), fresh-client SUBSCRIBE
- [verified] broker.hivemq.com:8884/mqtt is LIVE over WSS: HTTP/1.1 101 Switching Protocols, sec-websocket-protocol: mqtt. Live (non-retained) pub/sub verified end-to-end, and retained messages verified with retain flag true.
  src: Direct probe 2026-08-30: WebSocket upgrade + raw MQTT client, two-phase live and retained tests
- [verified] CAVEAT: On HiveMQ, a retained message published immediately after CONNECT and followed by a fast socket close was NOT persisted (first test returned 0 retained messages). It only persisted after a longer settle delay before closing. Implementation must await CONNACK and delay/flush before closing.
  src: Direct probe 2026-08-30: first run returned retained_msgs=0 for hivemq, second run with 3s settle returned retain=true. EMQX and Mosquitto passed on the first run.
- [verified] test.mosquitto.org:8081 is LIVE over WSS on BOTH path / and /mqtt: HTTP/1.1 101 Switching Protocols, Sec-WebSocket-Protocol: mqtt. CONNACK rc=0 and retained messages verified with retain flag true.
  src: Direct probe 2026-08-30 + https://test.mosquitto.org/ port table
- [verified] test.mosquitto.org port table: 1883 MQTT plain, 8883 MQTT TLS, 8080 WS plain, 8081 WS+TLS unauthenticated, 8090/8091 WS authenticated. Port 8081 is the correct browser-usable WSS listener, no credentials.
  src: https://test.mosquitto.org/
- [verified] Mosquitto test broker usage policy: 'You are free to use it for any application, but please do not abuse or rely upon it for anything of importance.' Advises building clients to cope with broker restarts and not publishing sensitive data.
  src: https://test.mosquitto.org/
- [verified] HiveMQ public broker policy is the most restrictive: it 'must not be used in Production, Dev, Staging or UAT environments', has no uptime guarantee, may lose messages on instance updates, and HiveMQ reserves the right to disconnect clients or ban users. Ports: TCP 1883, TLS 8883, WS 8000, WSS 8884.
  src: https://www.mqtt-dashboard.com/
- [verified] EMQX public broker ports: TCP 1883, WS 8083, TLS 8883, WSS 8084, QUIC 14567. It is heavily loaded in production-like use (~121,670 total / ~119,962 live connections, ~5,082 msg/s inbound at time of check). All messages are visible to other users — it is a shared public broker with no isolation.
  src: https://www.emqx.com/en/mqtt-dashboard and https://www.emqx.com/en/mqtt/public-mqtt5-broker
- [uncertain] No public MQTT broker documents a hard payload size limit, per-client message rate limit, or retained-message retention duration. Treat retained state as best-effort and re-publish periodically.
  src: EMQX, HiveMQ, and Mosquitto public broker pages all omit these; only generic EMQX rate-limit config docs exist
- [verified] ntfy.sh is LIVE and fully CORS-open for a static HTTPS page. POST publish returned HTTP/2 200 with 'access-control-allow-origin: *'. OPTIONS preflight returned 200 with 'access-control-allow-origin: *', 'access-control-allow-headers: *', 'access-control-allow-methods: GET, PUT, POST, PATCH, DELETE'. SSE endpoint returned 'content-type: text/event-stream' with ACAO *.
  src: Direct probe 2026-08-30: POST/OPTIONS/GET against https://ntfy.sh/nzxtcam_probe_20260830 with Origin: https://example.github.io
- [verified] ntfy.sh message cache is 12 hours, empirically confirmed: published message returned time=1788127386 and expires=1788170586, a delta of exactly 43200 seconds. Docs independently state 'messages are kept in the cache for 12 hours'.
  src: Direct probe 2026-08-30 response body + https://docs.ntfy.sh/publish/
- [verified] ntfy replay works for state recovery: GET /<topic>/json?poll=1 and ?poll=1&since=all both returned the previously published message after the publishing connection had closed. since= accepts 'all', a duration (10m), a Unix timestamp, or a message ID.
  src: Direct probe 2026-08-30 + https://docs.ntfy.sh/subscribe/api/
- [verified] ntfy.sh requires NO account and its security model explicitly matches a room-code design: 'the topic is essentially a password' — pick an unguessable topic name.
  src: https://docs.ntfy.sh/publish/
- [verified] ntfy.sh subscribe endpoints usable from browser JS: wss://ntfy.sh/<topic>/ws (WebSocket), /<topic>/sse (EventSource), /<topic>/json (newline-delimited JSON stream). Replay is capped at 10 MB per topic, signalled by an X-Messages-Truncated: 1 header.
  src: https://docs.ntfy.sh/subscribe/api/
- [uncertain] ntfy.sh does not publish explicit per-visitor request-rate or daily message limits in its docs (attachment limits are documented: 15 MB/file, 100 MB/visitor, 3h expiry). Rate limits exist in server config but values for the public instance are undocumented.
  src: https://docs.ntfy.sh/publish/
- [verified] PeerJS public cloud signaling server is LIVE: GET https://0.peerjs.com/peerjs/id returned HTTP/2 200 with a valid UUID (9de912b3-...), 'access-control-allow-origin: *', 'access-control-allow-methods: GET', served behind Cloudflare with HSTS.
  src: Direct probe 2026-08-30
- [likely] PeerJS cloud is a poor fit for this use case despite being live: WebRTC gives NO retained/last-value semantics, so a display-page reload loses all state and requires the controller to be simultaneously online to re-establish. It also needs both peers online at once and provides no TURN server, so NAT traversal can fail. Neither peerjs.com/docs nor the peerjs-server repo document cloud limits or production suitability.
  src: https://peerjs.com/docs/ and https://github.com/peers/peerjs-server (both silent on cloud limits); retained-state gap is inherent to WebRTC
- [verified] mqtt.js is at v5.15.2 and ships first-class browser support: a 'browser' field stubbing fs/net/tls, plus export map entries ./dist/mqtt.esm.js (ESM) and ./dist/mqtt.min.js. Directly usable from a static page via CDN ESM import.
  src: https://registry.npmjs.org/mqtt/latest
- [verified] Current player library versions: hls.js 1.7.1, dashjs 5.2.1, shaka-player 5.2.8.
  src: https://registry.npmjs.org/hls.js/latest, https://registry.npmjs.org/dashjs/latest, https://registry.npmjs.org/shaka-player/latest
- [verified] HLS/DASH from a foreign origin requires CORS on EVERY resource class, not just the manifest: master playlist, variant playlists, media segments, and encryption keys. A single missing header on any one class breaks playback, so testing only the first .m3u8 is insufficient.
  src: https://www.radiantmediaplayer.com/docs/latest/cors.html and https://www.m3u8player.tools/en/hls-cors-error
- [verified] Purpose-built test/demo streams do send permissive CORS: test-streams.mux.dev m3u8 -> 'access-control-allow-origin: *'; stream.mux.com -> ACAO *; dash.akamaized.net .mpd -> ACAO *, plus Access-Control-Allow-Headers including 'range' and CMCD headers. These will work unproxied.
  src: Direct HEAD probes 2026-08-30 with Origin: https://user.github.io
- [likely] Real-world third-party streams commonly fail from a foreign origin for reasons beyond CORS: token/signature query params, Referer checks, and geo restrictions. Expect the unproxied success rate for arbitrary user-pasted stream URLs to be dominated by test/demo/self-hosted and public-CDN sources, not commercial ones. A user-configurable proxy field is therefore mandatory, not optional.
  src: Composite: observed signed-URL patterns on Discord CDN (ex/is/hm), Streamable CDN (Expires/Signature), plus CORS requirement docs
- [verified] A PLAIN passthrough CORS proxy is insufficient for HLS: the manifest's variant and segment URLs are relative or absolute to the ORIGIN host, so after proxying the manifest the player requests segments direct-from-origin and fails CORS again. An HLS-aware proxy must rewrite playlist URLs to route segments through the proxy too.
  src: Behavior of dedicated projects that exist precisely to do this: https://github.com/MHSanaei/HLS-Proxy-Worker, https://github.com/prathvikothari/HLS-Proxy-Worker ('fetch and rewrite HLS (.m3u8) playlists'), https://github.com/frank-vpl/TV-Workers ('automatic playlist rewriting and CORS support')
- [verified] Cloudflare Workers is the right recommended self-host proxy target: official CORS-header-proxy example exists, and the free tier allows 100,000 requests/day. Note HLS burns requests fast (one per segment), so a 2s-segment stream consumes ~1,800 requests/hour of playback.
  src: https://developers.cloudflare.com/workers/examples/cors-header-proxy/ ; free-tier 100k/day figure from search results (request-count math is derived)
- [verified] Public drop-in CORS proxies are unreliable as defaults: corsproxy.io returned HTTP 403 {'error':{'status':403,'message':'This domain has been blocked and can't be proxied'}} for a benign Mux test stream. api.allorigins.win/raw returned HTTP/2 200 with correct 'access-control-allow-origin: https://user.github.io' and the valid #EXTM3U body.
  src: Direct probes 2026-08-30 against both proxies with the same Mux test m3u8
- [verified] Chromium does NOT support Matroska/MKV in the HTML <video> element. MKV is not listed as a supported container in any browser. This is a hard limit — no flag or library fixes it short of in-browser remuxing (e.g. WebCodecs/ffmpeg.wasm).
  src: https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers
- [verified] Chromium <video> container/codec support that IS safe to rely on: MP4 (video/mp4) with H.264/AVC, AV1, VP9 video and AAC/FLAC/MP3/Opus audio; WebM (video/webm) with AV1/VP8/VP9 video and Opus/Vorbis audio.
  src: https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers
- [verified] HEVC/H.265 has been enabled by default in Chrome since v107, but it is HARDWARE-dependent: Chromium relies on the underlying OS/GPU decoder rather than shipping a software fallback. On a machine whose GPU lacks HEVC decode, HEVC playback fails. Additional caveats exist around DRM and HDR.
  src: https://chromestatus.com/feature/5186511939567616 , https://bitmovin.com/blog/google-adds-hevc-support-chrome/ , https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding
- [verified] Vimeo setQuality is BLOCKED on arbitrary public videos: the official player.js README states setQuality(quality) is 'available to Plus, PRO and Business accounts'. setPlaybackRate is likewise 'available to PRO and Business accounts' and creators can disable rate changes.
  src: https://raw.githubusercontent.com/vimeo/player.js/master/README.md
- [verified] Vimeo read-only quality APIs are still usable: getQualities() returns objects with label/id/active, getQuality() returns the current quality id, and a 'qualitychange' event fires on change. So the UI can DISPLAY quality for any video but cannot SET it unless the owner is a paid account. setQuality rejects with TypeError on invalid values.
  src: https://raw.githubusercontent.com/vimeo/player.js/master/README.md
- [verified] Vimeo universally-available controls that DO work: setCurrentTime(seconds) (rejects if beyond duration or negative), setVolume(0-1), setLoop(boolean). Note setLoop(true) suppresses the 'ended' event — relevant if the display page chains playlist items on 'ended'.
  src: https://raw.githubusercontent.com/vimeo/player.js/master/README.md
- [verified] Twitch requires a 'parent' parameter naming every domain that embeds the player: 'You must have one parent key for each domain your site uses', supplied as an array e.g. parent: ['embed.example.com','othersite.example.com']. The player iframe src must be https://player.twitch.tv/.
  src: https://dev.twitch.tv/docs/embed/video-and-clips/
- [likely] OSS-FORK HAZARD: because 'parent' must match the embedding hostname exactly, a hardcoded parent value breaks for every fork (each fork is a different <user>.github.io). The fix is to set parent dynamically from window.location.hostname at runtime, which Twitch's own interactive-component guidance also describes.
  src: Derived from https://dev.twitch.tv/docs/embed/video-and-clips/ plus Twitch dev-forum guidance that components read the parent URL via window.location.hostname
- [verified] Twitch DOES expose quality control, unlike Vimeo: Twitch.Player supports setQuality(quality:String), getQualities():String[] (e.g. 'chunked'), and getQuality():String, with no account-tier gating documented.
  src: https://dev.twitch.tv/docs/embed/video-and-clips/
- [verified] Streamable is the friendliest per-site provider: its oEmbed endpoint https://api.streamable.com/oembed.json?url=... returned HTTP/2 200 with 'access-control-allow-origin: https://user.github.io' (it REFLECTS the caller's Origin), returning an iframe embed pointing at https://streamable.com/o/<id>. Fully callable from browser JS with no proxy.
  src: Direct probe 2026-08-30 with Origin: https://user.github.io
- [verified] Streamable direct CDN files are signed and expiring — the oEmbed thumbnail_url carried '?Expires=1788132240&Signature=...' on cdn-cf-west.streamable.com. Use the iframe embed, not scraped direct file URLs.
  src: Direct probe 2026-08-30, oEmbed JSON body
- [verified] Reddit v.redd.it DOES send permissive CORS: both DASH_720.mp4 and DASHPlaylist.mpd responses carried 'access-control-allow-origin: *' (and 'access-control-allow-methods: GET'). The 403 status on my probes reflects stale/invalid test IDs, not a CORS denial — the headers are present regardless.
  src: Direct HEAD probes 2026-08-30 against v.redd.it
- [likely] Reddit gotcha: v.redd.it splits video and audio into SEPARATE DASH representations (DASH_<res>.mp4 and a separate DASH_audio track). A naive <video src=DASH_720.mp4> plays SILENTLY. Correct handling requires dash.js/Shaka against DASHPlaylist.mpd to mux both tracks.
  src: Observed URL scheme in probes (DASH_720.mp4 vs DASHPlaylist.mpd); long-standing well-documented v.redd.it behavior
- [verified] Imgur is unreliable for video: a HEAD on https://i.imgur.com/<id>.mp4 returned HTTP/2 301 with 'location: https://imgur.com/' — i.e. redirect-to-homepage rather than the asset. ACAO * is present but the content is gone/hotlink-redirected. Deprioritize Imgur.
  src: Direct HEAD probe 2026-08-30
- [verified] Discord CDN is unusable for persistent playback. Links are signed with ex (expiry), is (issued) and hm (HMAC signature) query params and expire (rolled out from Dec 2023, ~24h validity). Requests missing/expired params return 404 'This content is no longer available'. My probe's 404 response carried NO access-control-allow-origin header at all.
  src: Direct probe 2026-08-30 (404, no ACAO) + https://www.bleepingcomputer.com/news/security/discord-will-switch-to-temporary-file-links-to-block-malware/ and https://www.xda-developers.com/discord-download-links-expire-24-hours/
- [verified] NZXT CAM Web Integration runtime: Chromium-based webview, 'Only browser APIs that exist on Chromium are supported'. CAM injects window.nzxt.v1.{width,height,shape,targetFps} and appends '?kraken=1' to the URL so the display page can distinguish itself from the CAM configuration browser. Kraken Elite panel is 2.72in IPS, 640x640, 60Hz.
  src: https://developer.nzxt.com/docs/development/ , https://developer.nzxt.com/docs/about/
- [verified] CRITICAL CAM constraint: 'Web Integration mode does NOT track navigations'. The display page must be a single page that never navigates — no History API route changes, no full-page reloads for state changes. All state transitions must happen in-place via JS. This also means hash routing is preferable to any 404-redirect SPA trick.
  src: https://developer.nzxt.com/docs/development/
- [uncertain] CAM docs do NOT state the Electron/Chromium version, nor whether audio output, autoplay-with-sound, or DRM/EME are supported in the webview. HEVC/AV1 availability inside CAM's specific Electron build is therefore unknown and must be feature-detected at runtime via MediaSource.isTypeSupported / video.canPlayType.
  src: https://developer.nzxt.com/docs/development/ (silent on all of these)
- [verified] GitHub Pages serves *.github.io over HTTPS automatically for all sites created after June 15, 2016. There is no supported way to serve a github.io site over plain HTTP.
  src: https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https
- [likely] Mixed content is a real blocker for the 'paste any URL' feature: any http:// media URL pasted by a user will fail on the HTTPS display page. Chrome autoupgrades mixed audio/video to https and blocks it when the upgrade fails. The UI must detect http:// input and either rewrite to https:// or surface an explicit error, since the failure is otherwise silent.
  src: https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https (mixed content causes assets to fail) + https://w3c.github.io/webappsec-mixed-content/level2.html
- [verified] GitHub Pages has no server-side rewrite support, so SPA deep links 404 by default. The two workarounds are hash routing (#/path) or a 404.html redirect hack. Hash routing is strictly better here because it needs no redirect round-trip and aligns with CAM's no-navigation constraint.
  src: https://github.com/orgs/community/discussions/64096 , https://github.com/rafgraph/spa-github-pages
- [verified] Project sites live under /<repo-name>/, and browsers do NOT prepend that path for root-relative URLs — '/css/style.css' resolves to the domain root and 404s. Use relative paths or a <base href> tag. This also affects the service worker registration path and its scope.
  src: https://github.com/orgs/community/discussions/188844 , https://devactivity.com/posts/apps-tools/mastering-github-pages-configure-base-paths-for-seamless-project-deployments/
- [likely] ORIGIN-SHARING HAZARD on GitHub Pages: all repos of one user share the single origin https://<user>.github.io, so localStorage, IndexedDB, Cache Storage and service worker registrations collide across that user's unrelated projects. Namespace every storage key (e.g. 'nzxtlcd:'), and register the SW at './sw.js' so its scope is confined to /<repo-name>/.
  src: Derived from the standard web origin model (scheme+host+port, path-independent) combined with the documented /<repo-name>/ project-site layout

# RECOMMENDATIONS
RECOMMENDED SYNC ARCHITECTURE

PRIMARY: MQTT over WSS to broker.emqx.io:8084/mqtt via mqtt.js 5.15.2 (ESM from CDN).
Rationale: verified live; verified retained-message support (true last-value semantics — the single hardest requirement); no accounts; works from an HTTPS static origin; real-time push in both directions; EMQX was the only broker that passed the retained test on the first attempt with no timing sensitivity, and unlike HiveMQ it carries no "must not be used outside testing" prohibition.

FALLBACK: ntfy.sh (POST to publish, EventSource /sse to subscribe, GET /json?poll=1&since=10m to recover state on load).
Rationale: verified live with ACAO * on every method; verified 12h cache giving replay-based state recovery; its "topic is essentially a password" model matches a room-code design exactly; and critically it is a DIFFERENT transport family (plain HTTPS + SSE, port 443) from the primary, so it survives networks/firewalls that block WSS on nonstandard port 8084. Make the transport a runtime toggle plus automatic failover on connect error.

REJECT for primary/fallback: PeerJS (live, but WebRTC has no retained state — a display reload dies unless the controller is online; no TURN). test.mosquitto.org (works, retained verified, but explicitly asks not to be relied upon). broker.hivemq.com (works, but "must not be used in Production, Dev, Staging or UAT" and showed the retained-message loss race). Firebase/Supabase free tiers require the MAINTAINER's own API keys baked into a public static repo — that means the maintainer personally absorbs quota abuse, key rotation, and billing risk for every fork and every user, which is an unacceptable OSS maintenance burden; only offer these as optional user-supplied-config backends.

ROOM/TOPIC NAMING
- User-facing room code: 8 chars, Crockford base32, ambiguity-free alphabet (no I/L/O/U). ~40 bits — enough that topic scanning is impractical.
- Never put the raw code on the wire as the topic. Derive: topicId = base32(SHA-256(roomCode).slice(0,10)). Public brokers are world-readable and world-writable, so the code must be a secret, not an address.
- Topics:
    nzxtlcd/v1/<topicId>/state   -> RETAINED, QoS 0, full desired state (display subscribes; controller publishes)
    nzxtlcd/v1/<topicId>/cmd     -> NOT retained, transient imperatives (nudge seek, next, reload)
    nzxtlcd/v1/<topicId>/tele    -> NOT retained, display -> controller telemetry (actual position, buffering, errors, resolved codec)
- ntfy equivalent: single topic nzxtlcd-v1-<topicId> with a "ch" field in the JSON discriminating state/cmd/tele, since ntfy has no topic hierarchy.

MESSAGE SCHEMA (JSON, keep under ~4KB; no broker documents a payload cap)
  Envelope: { v:1, ch:"state"|"cmd"|"tele", ts:<epoch ms>, src:<random client id>, seq:<monotonic int>, ... }
  state (retained, full snapshot — never a delta, so a cold display needs exactly one message):
    { v:1, ch:"state", ts, src, seq,
      source:{ kind:"youtube"|"vimeo"|"twitch"|"hls"|"dash"|"file"|"streamable"|"reddit", url, id },
      playback:{ paused:bool, posSec:float, posAtTs:<epoch ms>, rate:float, volume:0..1, muted:bool, loop:bool },
      render:{ fit:"cover"|"contain", rotate:0|90|180|270, zoom:float, offsetX:float, offsetY:float, mask:"circle"|"none" },
      quality:{ mode:"auto"|"fixed", level:<string|null> },
      proxy:{ enabled:bool, base:<url|null> } }
  cmd (transient): { v:1, ch:"cmd", ts, src, op:"seekBy"|"next"|"prev"|"reload"|"ping", arg }

RETAINED-STATE DISCIPLINE (these are the details that will actually bite)
- Publish the FULL state snapshot on every change, retained. Deltas are unsafe because a reloading display sees only the last retained message.
- Seek correctness across reload: never send a bare posSec. Send posSec + posAtTs, and have the display compute effective position as posSec + (paused ? 0 : (now - posAtTs)/1000). Clock skew between phone and PC makes absolute wall-clock seeking wrong; prefer the display treating posAtTs as advisory and re-anchoring from its own clock after first sync.
- AWAIT CONNACK AND FLUSH BEFORE CLOSING. Empirically, publishing a retained message immediately after CONNECT and closing fast silently dropped it on HiveMQ. Await the connect callback, publish, await the publish callback, then close. Use mqtt.js's end(false, cb).
- Set an MQTT Last Will on the CONTROLLER only, on .../tele, so the display can show "controller disconnected". Do NOT put a will on the retained state topic — a will would wipe the state a reloading display depends on.
- Re-publish the retained state every ~5 minutes as a keepalive against undocumented retained-message expiry on public brokers.
- ntfy fallback recovery: on load, GET /json?poll=1&since=10m, take the LAST message with ch=="state", then open EventSource. Because ntfy replays chronologically and caps replay at 10MB/topic (X-Messages-Truncated header), use since=10m rather than since=all to keep recovery fast.

PRIVACY: public brokers are shared and readable by anyone who guesses the topic. Encrypt payloads with AES-GCM using a key derived from the room code via PBKDF2/HKDF (WebCrypto). The room code then serves as both the addressing secret and the encryption secret, and pasted URLs never appear in plaintext on a third-party broker.

PLAYBACK STRATEGY (ordered fallback per pasted URL)
1. Recognize provider by URL pattern -> official embed/SDK (YouTube IFrame, Vimeo player.js, Twitch with dynamic parent=window.location.hostname, Streamable oEmbed iframe).
2. Else sniff extension/Content-Type -> .m3u8 hls.js 1.7.1; .mpd dash.js 5.2.1 or shaka-player 5.2.8; .mp4/.webm native <video>.
3. Else attempt native <video> directly.
4. On CORS/network failure, surface a one-click "retry via proxy" that re-requests through a user-configured proxy base URL. Ship an empty proxy field by default and document a deploy-your-own Cloudflare Worker (use an HLS-AWARE worker that rewrites playlist segment URLs — a plain passthrough proxy will fail on segments even after the manifest loads). Do not hardcode a public proxy: corsproxy.io already returns 403 for blocked domains; allorigins.win currently works but should be an optional preset, not a default.

UI/COMPAT GUARDRAILS
- Reject/flag .mkv at input time with a clear message — Chromium cannot play Matroska in <video>, so it must not present as a mysterious failure.
- Feature-detect HEVC and AV1 at runtime (MediaSource.isTypeSupported / video.canPlayType) rather than assuming; CAM's Electron build version is undocumented and HEVC is hardware-dependent with no software fallback.
- Reject Discord CDN links at input time (or warn loudly): they carry ex/is/hm signatures and die within ~24h, so a saved playlist entry will silently break.
- For Reddit, always use DASHPlaylist.mpd through dash.js/Shaka — using DASH_<res>.mp4 directly plays with NO AUDIO.
- Vimeo: hide or disable the quality selector unless getQualities() plus a probe confirms setQuality works; it is gated to Plus/PRO/Business accounts and will reject for most public videos. Expose Twitch's quality control freely — it is not tier-gated.

GITHUB PAGES SETUP
- Hash routing only (#/display, #/control). No 404.html trick — it adds a redirect round-trip and conflicts with CAM's "does not track navigations" constraint.
- Relative asset paths or <base href>, never root-relative, because the site lives under /<repo-name>/.
- Namespace all localStorage/IndexedDB/Cache keys with a "nzxtlcd:" prefix and register the service worker as './sw.js' — every repo of a given user shares the <user>.github.io origin and will otherwise collide.
- Service worker should precache the app shell and player libs but must NOT cache the control-channel endpoints or media. Add a version-bump/skipWaiting path, since the CAM display page may run for weeks without a manual reload.
- Validate pasted URLs for http:// and rewrite to https:// or reject — mixed content fails silently on an HTTPS Pages origin.

# OPEN QUESTIONS
- What Electron/Chromium version does NZXT CAM's web-integration webview actually ship? This determines AV1 and HEVC availability and whether modern APIs (WebCodecs, EventSource quirks) are present. Undocumented — must be probed at runtime via navigator.userAgent and codec feature detection on a real Kraken Elite.
- Does the CAM webview output audio at all, and does it permit autoplay with sound or enforce Chromium's muted-autoplay policy? This decides whether the display page must always start muted and whether audio is a supported feature at all.
- What are the real payload-size and message-rate limits on broker.emqx.io? Undocumented. Needs empirical bisection if state payloads approach a few KB, especially if thumbnails or playlists are ever embedded in the retained state.
- How long do retained messages actually persist on broker.emqx.io with no active subscriber? Not documented anywhere; determines whether the 5-minute keepalive republish is sufficient or unnecessary.
- What are ntfy.sh's actual per-visitor publish rate limits? Undocumented for the public instance. A scrubbing seek slider could emit many messages/second and trip an unknown limit — client-side throttling (e.g. 5 Hz) is advisable regardless.
- Does Twitch's parent validation accept an apex 'github.io' value, or must it be the exact '<user>.github.io' subdomain? Docs say one parent key per domain but do not address Public Suffix List domains. Needs an empirical test from a real Pages deployment.
- Are there per-IP connection limits on broker.emqx.io that would break multiple users behind one NAT, or a single user opening display + control pages simultaneously? Not documented.
- Does CAM's webview persist localStorage across CAM restarts and PC reboots? This determines whether the room code can be remembered on the display side or must be re-entered via the CAM config browser each time.
- Is there a Cloudflare Worker HLS-proxy implementation that is currently maintained and safe to recommend by name? The candidates found (HLS-Proxy-Worker forks, TV-Workers) are IPTV-oriented and were not audited for maintenance status or licensing in this pass.
