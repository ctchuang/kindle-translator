# Layout model (downloaded at first use, not stored here)

The extension detects page layout (text blocks, headings, figures, tables,
captions) with DocLayout-YOLO trained on DocStructBench, exported to ONNX:

- File: `doclayout_yolo_docstructbench_imgsz1024.onnx` (75.3 MB)
- Source: https://huggingface.co/wybxc/DocLayout-YOLO-DocStructBench-onnx
  (Apache-2.0), the same export BabelDOC uses
- SHA-256: `fece9af02f618b603ff7921ccec6861d13e7e1f9830e091dfb7e8ad9311e5b21`
- Original model: DocLayout-YOLO by OpenDataLab,
  https://github.com/opendatalab/DocLayout-YOLO

The offscreen document downloads the file the first time it's needed, checks
the SHA-256 and keeps it in the extension's Cache Storage. `LICENSE` in this
directory is the Apache License 2.0 the model is distributed under.

The preprocessing (BGR, letterbox padded with 114, 1024×1024, /255) and the
class list follow BabelDOC (https://github.com/funstory-ai/BabelDOC).
