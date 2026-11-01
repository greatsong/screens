"""다른 프로젝트 폴더 위치를 찾는다. 코드에 절대경로를 적지 않기 위한 도우미."""


def project_dir(name):
    """다른 프로젝트 폴더. greatsong-project/paths.json(폴더 재편 스크립트가 관리)에서 찾는다."""
    import json, os, pathlib
    root = os.environ.get("GREATSONG_ROOT") or next(
        (p for p in pathlib.Path(__file__).resolve().parents if (p / "paths.json").is_file()), None)
    if root is None:
        raise FileNotFoundError("greatsong-project/paths.json을 찾지 못했습니다. GREATSONG_ROOT를 지정하세요.")
    root = pathlib.Path(root)
    return root / json.loads((root / "paths.json").read_text(encoding="utf-8"))[name]
