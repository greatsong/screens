"""하교 버스 카드의 배경 지도(site/bus/map.webp)를 만든다.

OpenStreetMap 타일 몇 장을 받아 학교와 두 정류장이 들어오는 범위로 자른다. 한 번 만들어 저장소에 넣어 두므로
화면은 타일 서버를 부르지 않는다. 범위를 바꾸면 content.json 의 bus.map.bounds 도 출력값으로 바꾼다.
사용법: python3 scripts/build_bus_map.py
지도 저작권: © OpenStreetMap 기여자 (ODbL)
"""
import io
import math
import pathlib
import time
import urllib.request

from PIL import Image, ImageEnhance

ZOOM = 18
NORTH, SOUTH, WEST, EAST = 37.49445, 37.49045, 126.93235, 126.93765
OUT = pathlib.Path(__file__).resolve().parent.parent / "site" / "bus" / "map.webp"


def tile_xy(lat, lon):
    n = 2 ** ZOOM
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def main():
    x0, y0 = tile_xy(NORTH, WEST)
    x1, y1 = tile_xy(SOUTH, EAST)
    tx0, ty0, tx1, ty1 = int(x0), int(y0), int(x1), int(y1)
    sheet = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            req = urllib.request.Request(f"https://tile.openstreetmap.org/{ZOOM}/{tx}/{ty}.png",
                                         headers={"User-Agent": "school-signage-static-map/1.0 (one-off build)"})
            with urllib.request.urlopen(req, timeout=20) as res:
                sheet.paste(Image.open(io.BytesIO(res.read())).convert("RGB"), ((tx - tx0) * 256, (ty - ty0) * 256))
            time.sleep(0.3)
    box = tuple(round(v) for v in ((x0 - tx0) * 256, (y0 - ty0) * 256, (x1 - tx0) * 256, (y1 - ty0) * 256))
    img = sheet.crop(box)
    img = ImageEnhance.Color(img).enhance(0.75)       # 표식이 잘 보이게 채도를 조금 낮춘다
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, "WEBP", quality=82)
    print(OUT, img.size, {"north": NORTH, "south": SOUTH, "west": WEST, "east": EAST})


if __name__ == "__main__":
    main()
