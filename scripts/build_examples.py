"""Generate the three example notebooks shipped under /examples.

Run with:
    uv run python scripts/build_examples.py

The script writes deterministic .ipynb files via nbformat so the examples
can be rebuilt and reviewed without checking opaque JSON into the repo.

The notebooks are intentionally varied in shape so FlowQuest surfaces
different regions, missions, activities, and issues in each one. The copy
matches FlowQuest's current model: global XP, levels, missions, quizzes,
Flowy, and per-notebook difficulty (there is no "health" score).
"""

from __future__ import annotations

from pathlib import Path

import nbformat as nbf


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "examples"


def make_notebook(cells: list[nbf.NotebookNode], description: str) -> nbf.NotebookNode:
    nb = nbf.v4.new_notebook()
    nb.metadata["kernelspec"] = {
        "display_name": "Python 3",
        "language": "python",
        "name": "python3",
    }
    nb.metadata["language_info"] = {"name": "python"}
    nb.metadata["flowquest_example"] = {"description": description}
    nb.cells = cells
    return nb


def md(text: str) -> nbf.NotebookNode:
    return nbf.v4.new_markdown_cell(text)


def code(text: str) -> nbf.NotebookNode:
    return nbf.v4.new_code_cell(text)


def write(name: str, nb: nbf.NotebookNode) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / f"{name}.ipynb"
    nbf.write(nb, target)
    print(f"wrote {target.relative_to(ROOT)}")


# ---------------------------------------------------------------------------
# 01 — explore a synthetic coffee-shop sales dataset (no model)
# ---------------------------------------------------------------------------


def example_explore() -> nbf.NotebookNode:
    return make_notebook(
        [
            md(
                "# Coffee shop sales — a first look\n\n"
                "A short exploration of one month of (synthetic) orders from a "
                "little coffee shop. We load the data, tidy it up, summarise it, "
                "and draw a couple of plots.\n\n"
                "> **FlowQuest tip:** open the sidebar and try the **Explain** "
                "action on a cell to earn *exploration* XP, then claim the "
                "missions that appear in the **Quest** tab."
            ),
            md("## Setup"),
            code(
                "import numpy as np\n"
                "import pandas as pd\n"
                "import matplotlib.pyplot as plt\n"
                "\n"
                "rng = np.random.default_rng(seed=21)"
            ),
            md(
                "## Load the orders\n\n"
                "We synthesise a month of orders so the notebook runs anywhere."
            ),
            code(
                "n_orders = 600\n"
                "drinks = ['espresso', 'latte', 'cappuccino', 'mocha', 'tea']\n"
                "prices = {'espresso': 2.5, 'latte': 3.5, 'cappuccino': 3.5, 'mocha': 4.0, 'tea': 2.0}\n"
                "\n"
                "orders = pd.DataFrame({\n"
                "    'day': rng.integers(1, 31, size=n_orders),\n"
                "    'hour': rng.integers(7, 19, size=n_orders),\n"
                "    'drink': rng.choice(drinks, size=n_orders, p=[0.25, 0.3, 0.2, 0.15, 0.1]),\n"
                "    'size': rng.choice(['S', 'M', 'L'], size=n_orders, p=[0.3, 0.45, 0.25]),\n"
                "})\n"
                "orders.head()"
            ),
            md(
                "## Clean & enrich\n\n"
                "Derive the price for each order and a simple part-of-day label."
            ),
            code(
                "size_multiplier = {'S': 1.0, 'M': 1.2, 'L': 1.5}\n"
                "orders['price'] = (\n"
                "    orders['drink'].map(prices) * orders['size'].map(size_multiplier)\n"
                ").round(2)\n"
                "\n"
                "def part_of_day(hour: int) -> str:\n"
                "    if hour < 11:\n"
                "        return 'morning'\n"
                "    if hour < 15:\n"
                "        return 'midday'\n"
                "    return 'afternoon'\n"
                "\n"
                "orders['part_of_day'] = orders['hour'].map(part_of_day)\n"
                "orders.head()"
            ),
            md("## Explore\n\nA few quick questions: what sells, and when?"),
            code("orders['drink'].value_counts()"),
            code(
                "orders.groupby('part_of_day')['price'].agg(['count', 'sum', 'mean']).round(2)"
            ),
            md("## Visualise\n\nRevenue by drink, and orders across the day."),
            code(
                "revenue = orders.groupby('drink')['price'].sum().sort_values()\n"
                "\n"
                "fig, ax = plt.subplots(figsize=(6, 3))\n"
                "ax.barh(revenue.index, revenue.values, color='#7c5cff')\n"
                "ax.set_xlabel('total revenue')\n"
                "ax.set_title('Revenue by drink')\n"
                "plt.tight_layout()\n"
                "plt.show()"
            ),
            code(
                "by_hour = orders.groupby('hour').size()\n"
                "\n"
                "fig, ax = plt.subplots(figsize=(6, 3))\n"
                "ax.plot(by_hour.index, by_hour.values, marker='o', color='#18cdd4')\n"
                "ax.set_xlabel('hour of day')\n"
                "ax.set_ylabel('orders')\n"
                "ax.set_title('Orders throughout the day')\n"
                "plt.tight_layout()\n"
                "plt.show()"
            ),
            md(
                "## Reflect\n\n"
                "What's the single most surprising thing in these plots? Open a "
                "cell's FlowQuest chip and pick **Reflect** to put it in words and "
                "earn *reflection* XP."
            ),
        ],
        description="Synthetic coffee-shop orders: load, clean, explore, two plots.",
    )


# ---------------------------------------------------------------------------
# 02 — classify wine quality (full load → clean → model → evaluate workflow)
# ---------------------------------------------------------------------------


def example_model() -> nbf.NotebookNode:
    return make_notebook(
        [
            md(
                "# Wine classification — a tiny model\n\n"
                "Loads scikit-learn's wine dataset, trains a random-forest "
                "classifier, and evaluates it. This notebook touches every region "
                "FlowQuest knows about — `setup`, `load`, `clean`, `explore`, "
                "`visualize`, and `model` — so you'll see a between-cell activity "
                "or two appear.\n\n"
                "> **FlowQuest tip:** switch the **difficulty** in the banner and "
                "generate a fresh quiz at a checkpoint — the questions get harder."
            ),
            md("## Setup"),
            code(
                "import pandas as pd\n"
                "import matplotlib.pyplot as plt\n"
                "\n"
                "from sklearn.datasets import load_wine\n"
                "from sklearn.ensemble import RandomForestClassifier\n"
                "from sklearn.model_selection import train_test_split\n"
                "from sklearn.metrics import accuracy_score, confusion_matrix, ConfusionMatrixDisplay"
            ),
            md("## Load"),
            code(
                "wine = load_wine(as_frame=True)\n"
                "df = wine.frame\n"
                "print(df.shape)\n"
                "df.head()"
            ),
            md("## Explore the targets\n\nHow balanced are the three classes?"),
            code(
                "df['target'].value_counts().rename(index=dict(enumerate(wine.target_names)))"
            ),
            md(
                "## Clean & split\n\n"
                "Nothing to impute here, so we just separate features and split."
            ),
            code(
                "X = df.drop(columns=['target'])\n"
                "y = df['target']\n"
                "\n"
                "X_train, X_test, y_train, y_test = train_test_split(\n"
                "    X, y, test_size=0.25, random_state=0, stratify=y\n"
                ")\n"
                "X_train.shape, X_test.shape"
            ),
            md("## Train a random forest"),
            code(
                "model = RandomForestClassifier(n_estimators=200, random_state=0)\n"
                "model.fit(X_train, y_train)"
            ),
            md("## Evaluate"),
            code(
                "pred = model.predict(X_test)\n"
                "print('accuracy:', round(accuracy_score(y_test, pred), 3))"
            ),
            code(
                "cm = confusion_matrix(y_test, pred)\n"
                "disp = ConfusionMatrixDisplay(cm, display_labels=wine.target_names)\n"
                "disp.plot(cmap='Purples')\n"
                "plt.title('Confusion matrix')\n"
                "plt.show()"
            ),
            md("## Visualise what mattered\n\nWhich features did the forest lean on?"),
            code(
                "importances = (\n"
                "    pd.Series(model.feature_importances_, index=X.columns)\n"
                "    .sort_values()\n"
                "    .tail(8)\n"
                ")\n"
                "\n"
                "fig, ax = plt.subplots(figsize=(6, 4))\n"
                "ax.barh(importances.index, importances.values, color='#2dd4a7')\n"
                "ax.set_title('Top feature importances')\n"
                "plt.tight_layout()\n"
                "plt.show()"
            ),
            md(
                "## Reflect\n\n"
                "Accuracy is high — but is that the whole story? Use **Reflect** to "
                "note one risk of trusting this number, and the Flowy quiz to check "
                "you understand what the confusion matrix shows."
            ),
        ],
        description="Wine classification with a random forest, confusion matrix, importances.",
    )


# ---------------------------------------------------------------------------
# 03 — intentionally messy notebook to give FlowQuest something to flag
# ---------------------------------------------------------------------------


def example_messy() -> nbf.NotebookNode:
    return make_notebook(
        [
            md(
                "# Messy on purpose\n\n"
                "This notebook has **out-of-order execution**, an **unused "
                "variable**, and a **duplicated cell**. Re-scan it from the "
                "FlowQuest banner and watch the *stabilization* missions populate — "
                "claiming each fix pours XP into your global total."
            ),
            md("## Setup"),
            # Pre-set execution counts so FlowQuest's analyzer sees the disorder
            # the moment the notebook is opened — without anyone running it.
            nbf.v4.new_code_cell(
                source="import pandas as pd\nimport numpy as np",
                execution_count=2,
            ),
            md("## Load"),
            nbf.v4.new_code_cell(
                source=(
                    "df = pd.DataFrame({\n"
                    "    'city': ['Berlin', 'Paris', 'Rome', 'Madrid', 'Vienna'],\n"
                    "    'temp': [12.5, 14.0, 18.2, 19.1, 11.3],\n"
                    "    'rain_mm': [58, 49, 38, 28, 66],\n"
                    "})\n"
                    "df"
                ),
                execution_count=1,  # out of order on purpose
            ),
            md("## Clean (twice, oops)"),
            nbf.v4.new_code_cell(
                source="df = df.dropna()",
                execution_count=3,
            ),
            nbf.v4.new_code_cell(
                source="df = df.dropna()",  # duplicate of the cell above
                execution_count=4,
            ),
            md("## Define an unused helper"),
            nbf.v4.new_code_cell(
                source="rain_cumsum = df['rain_mm'].cumsum()  # computed but never used again",
                execution_count=5,
            ),
            md("## Inspect"),
            nbf.v4.new_code_cell(
                source="df.sort_values('temp', ascending=False)",
                execution_count=6,
            ),
            md(
                "## Your move\n\n"
                "Fix the smells (drop the duplicate, remove or use the leftover "
                "variable, re-run top-to-bottom) and claim the missions as they "
                "auto-clear."
            ),
        ],
        description="Notebook with on-purpose smells to exercise FlowQuest's checks.",
    )


def main() -> None:
    write("01_explore", example_explore())
    write("02_model", example_model())
    write("03_messy_on_purpose", example_messy())


if __name__ == "__main__":
    main()
