# Asset credits

## Paintings and prints (public domain)

All of these are faithful reproductions of two-dimensional works whose authors died more than a century ago. Except for the first row, the files were taken from Wikimedia Commons (links below), cropped, and rebuilt with `tools/build-background.js`.

| File | Work | Artist | Source |
|---|---|---|---|
| `moonsea.jpg`, `live-tex.jpg`, `backgrounds/moonsea*.webp` | A moonlit seascape with a ship (exact title not identified) | Ivan Aivazovsky (1817–1900) | a reproduction the author had on hand; no source page recorded |
| `backgrounds/wave*.webp` | The Great Wave off Kanagawa | Katsushika Hokusai (1760–1849) | [File:Tsunami by hokusai 19th century.jpg](https://commons.wikimedia.org/wiki/File:Tsunami_by_hokusai_19th_century.jpg) |
| `backgrounds/starry*.webp` | Starry Night Over the Rhône | Vincent van Gogh (1853–1890) | [File:Vincent van Gogh - Starry Night - Google Art Project.jpg](https://commons.wikimedia.org/wiki/File:Vincent_van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg) |
| `backgrounds/rain*.webp` | Sudden Shower over Shin-Ōhashi Bridge and Atake | Utagawa Hiroshige (1797–1858) | [File:Hiroshige, Sudden shower over Shin-Ōhashi bridge and Atake, 1857.jpg](https://commons.wikimedia.org/wiki/File:Hiroshige,_Sudden_shower_over_Shin-%C5%8Chashi_bridge_and_Atake,_1857.jpg) |
| `backgrounds/forest*.webp` | Morning in a Pine Forest | Ivan Shishkin (1832–1898) and Konstantin Savitsky (1844–1905) | [File:Shishkin, Ivan - Morning in a Pine Forest.jpg](https://commons.wikimedia.org/wiki/File:Shishkin,_Ivan_-_Morning_in_a_Pine_Forest.jpg) |
| `backgrounds/map*.webp` | Typus Orbis Terrarum | Abraham Ortelius (1527–1598) | [File:OrteliusWorldMap.jpeg](https://commons.wikimedia.org/wiki/File:OrteliusWorldMap.jpeg) |

`live-mask.png` is a hand-made mask for the living painting (which parts are sea, cloud and ship). It is part of this project (MIT).

## Drawings made for this project (MIT, same as the code)

- `anchor.png`, `rope.png` — line-art anchor and its rope, generated with an image model and then recoloured and cut for the page.
- `boat.png` — the small gold-line boat of the entrance animation, generated with an image model.
- `cloud.webp`, `cloud-dot-m.webp`, `cloud-dot-s.webp` — the stitched-paper thought cloud, drawn by the project's author.
- `paper-grain.png` — procedurally generated noise.

## Pictures in the demo articles

Each picture in `public/demo/images/` comes from Wikimedia Commons and keeps its own licence. They are modified copies: scaled down to at most 1280 px and given a slight sepia tone by the picture pipeline. Under CC BY-SA the modified copy stays under the same licence; author, licence and source page are stored with the article in `demo/data.json` and shown under the picture on the page.

## Fonts (loaded from CDNs, not bundled)

LXGW WenKai, Noto Serif SC, Cormorant Garamond and Great Vibes, all under the SIL Open Font License.

## Screenshots

`docs/cover.png`, `docs/reader.png` and `docs/social-preview-reader.jpg` are screenshots of this project's own pages showing the artwork above. `docs/social-preview.jpg` (the banner) is composed in `docs/social-preview.html` from the Aivazovsky painting, the boat drawing and that screenshot.
