# OCR regression evidence

Captured from the author's games at 3440 x 1440:

- `quest-title.json`: capture from `offer-1790736431849.json`. All three titles were
  read correctly; `Quest: Steel Your Heart` failed catalogue matching (ID 1152).
- `renamed-title.json`: capture from `offer-1790588769335.json`. `Rabble Rousing` was
  read correctly but the ARAM catalogue names ID 1067 `Rejuvenation`.
  CommunityDragon's `ARAM_RabbleRousing` entry independently associates ID 1067
  with Rejuvenation. Arena's `RabbleRousing` entry is ID 67 and must not be used.
- `unreadable-band.png`: original `capture-1790588992192.png`, a 2408 x 792 crop at
  (516, 288). The original worker returned zero lines, reproduced on Windows on
  2026-09-30. Focused title crops recover Final Form, Cruelty, Ult Bot.

The original PNG is already 8-bit and cannot prove recovery of clipped HDR pixels.
Native HDR conversion tests use synthetic FP16 values. Live Windows desktop smoke
on 2026-09-30 returned DXGI R16G16B16A16_FLOAT, HDR enabled, Reinhard/sRGB mapping.
A fresh in-game run remains the final validation of capture and recognition together.
