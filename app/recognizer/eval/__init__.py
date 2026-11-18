"""Research, eval and data scripts for the recognizer. Not imported by the service (server.py and its modules).

Run them as modules from app/recognizer, so the service modules (templates, personal, segment, ...) import as usual:

    uv run python -m eval.build_templates      # -> models/templates.npz (runtime, optional)
    uv run python -m eval.build_demo_model     # -> models/demo_generic.npz + models/demo_model.npz (runtime, optional)
    uv run --group eval python -m eval.eval_wlasl --spell
"""
