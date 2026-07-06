# Rythu Connect — రైతు కనెక్ట్

**🌐 Live app: https://gvrreddy233.github.io/rythu-connect/** (open on any phone; Android Chrome offers "Add to Home Screen" to install)

A bilingual (Telugu/English) web app for small farmers around Hyderabad:

- **🗺️ Map** — 12 Hyderabad rythu bazars + 10 proposed collection points on the major highways into the city (NH-44, NH-65, NH-163, Rajiv Rahadari, Srisailam Hwy, Chevella Rd). Pin-correction mode lets anyone drag a mislocated pin to its true spot.
- **📝 Register** — farmers register with their village (tap on map), farmer type, and what they're bringing today from a 40-item produce catalog. The app instantly shows their nearest collection point, its highway, and the money saved vs travelling into Hyderabad alone.
- **🚚 Transport groups** — farmers headed to the same collection point are pooled into one vehicle (auto / Tata Ace / mini truck) with shared vs solo cost, shareable to WhatsApp in one tap.
- **🏪 Market demand** — bazar managers see what produce is arriving today from which collection point, with CSV export.

## Run

Any static file server works — no build step:

```
py -m http.server 8123 --directory .
```

Then open http://localhost:8123

## Tech

Plain HTML/CSS/JS + [Leaflet](https://leafletjs.com) with OpenStreetMap tiles. Installable PWA (offline-capable service worker). All data stored in browser localStorage — a multi-user backend is the next milestone.

## Status

Prototype. Bazar coordinates are approximate — verify on ground (or use the in-app pin correction mode).
