# Sound Coverage Study

An offline, browser-based screening tool for in-plant paging (IPPS), public address (PA), and emergency siren (ESS) coverage studies. It is built from the engineering references stored at the root of this repository.

## Open the app

Open `Sound_Coverage_Study_Standalone.html` in a current desktop browser. It contains its CSS, calculation engine, and interface in one file; no server or internet connection is required.

The editable source version is `index.html` plus `src/`. Run:

```text
npm run check
```

This validates the JavaScript, runs the acoustic-model tests, and regenerates the standalone HTML.

## Included workflow

- PAGING, PA, and ESS acceptance presets traced to the three IFC studies.
- Interactive receiver-plane heatmap for compliance, sound level, or signal-to-noise margin.
- Drag-and-place sound sources with a direct rotation handle, live beam feedback, optional 15-degree Shift snapping, and editable horizontal/vertical −6 dB beam inputs.
- Device selection by S-key/toolbar sweep, direct empty-space drag-box, or Ctrl/Cmd and Shift additive selection, with live absolute-azimuth batch editing, shared engineering-property editing, confirmed multi-delete, and per-category Clear all actions.
- Rectangular ambient-noise zones and simplified line-of-sight obstacles.
- Energetic summation of multiple sources.
- Connected-load and amplifier-headroom schedule by speaker loop.
- Plan-image background, offline browser autosave, project JSON import/export, receiver-grid CSV export, and print-ready study output.
- Drawing-scale calibration (1:50 through custom ratios), editable raster DPI, proportional geometry resizing, and a two-click verification ruler.
- Noise-zone graphic visibility toggle plus pointer-centered wheel zoom and 50%-800% toolbar zoom controls.
- Middle-mouse drag panning and lighting-style automatic source placement inside a drawn rectangle, with compliance-calculated scientific spacing by default, manual maximum X/Y spacing as an option, and every generated source fixed at 0° azimuth.
- Embedded source register, case benchmarks, assumptions, and issue-before-use warnings.

## Calculation boundary

For source *i*, the screening calculation is:

```text
Lp,i = Lref + 10 log10(P / Pref) - 20 log10(r / rref) - directivity - attenuation
Ltotal = 10 log10(sum(10^(Lp,i / 10)))
```

The app remains a free-field screening model. It does not reproduce EASE, ISO 9613 octave-band propagation, full manufacturer polar data, reflections, diffraction, reverberant buildup, STI/RASTI, or commissioning measurements. It can therefore under-predict indoor levels beyond the critical distance, and its obstacle loss is a binary user-entered screen rather than a diffraction calculation. Device profiles marked **Verify** contain editable placeholders because the repository documents name the equipment and power rating but do not expose complete machine-readable sensitivity and polar data. Replace those fields with approved datasheet data before relying on a result.

The ESS study maps in dBC while also stating a personnel maximum in dBA. The app therefore leaves that maximum unenforced by default until the weighting basis is reconciled by the engineer.

## Repository sources used

- `CE-040449-001_SOUND COVERAGE STUDY FOR IN-PLANT PAGING SYSTEM(IFC, Rev.00A).docx`
- `CE-040450-001_SOUND COVERAGE STUDY FOR EMERGENCY SIREN SYSTEM(IFC, Rev.00A).docx`
- `CE-040451-001_SOUND COVERAGE STUDY FOR PUBLIC ADDRESS SYSTEM(IFC, Rev.00A).docx`
- `Maintenance Building_PAGA.pdf`
- `Substation PAGA.pdf`
- `Block Diagram PAGA.pdf`

`Acoustic Study.pdf` is preserved in the repository, but its stored bytes do not begin with a PDF signature and standard PDF parsers cannot read it. The app discloses that limitation rather than silently treating it as evidence.
