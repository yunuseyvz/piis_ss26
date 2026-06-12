# Example notebooks

Three short notebooks designed to exercise FlowQuest. Each one has a different shape so the extension shows different missions, activities, and issues.

| File | What it shows |
| --- | --- |
| `01_explore.ipynb` | Setup, load, clean, descriptive stats and two plots over synthetic coffee-shop orders. Good for trying the **Explain** action and earning exploration XP. |
| `02_model.ipynb` | A full load → explore → clean → model → evaluate workflow on scikit-learn's wine dataset (random forest, confusion matrix, feature importances). Touches every FlowQuest region and triggers between-cell activities. |
| `03_messy_on_purpose.ipynb` | A notebook with out-of-order execution, an unused variable, and a duplicated cell. Re-scan it and watch the stabilization missions populate. |

All three are regenerated from `scripts/build_examples.py`. To rebuild:

```bash
uv run python scripts/build_examples.py
```

You don't need to run that as part of normal development — the `.ipynb` files are committed.
