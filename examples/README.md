# Example notebooks

Three short notebooks designed to exercise FlowQuest. Each one has a different shape so the extension shows different missions, quizzes, and health behaviour.

| File | What it shows |
| --- | --- |
| `01_explore.ipynb` | Setup, load, descriptive stats, one plot. Good for trying the **🔍 Explain** action and earning Reader-Understanding points. |
| `02_model.ipynb` | A full load → clean → model → evaluate workflow on iris. Showcases all FlowQuest regions and the per-region quiz cells. |
| `03_messy_on_purpose.ipynb` | A notebook with out-of-order execution, an unused variable, and a duplicated cell. Press **🚀 Initialize FlowQuest** and watch the missions populate. |

All three are regenerated from `scripts/build_examples.py`. To rebuild:

```bash
uv run python scripts/build_examples.py
```

You don't need to run that as part of normal development — the `.ipynb` files are committed.
