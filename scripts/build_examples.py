"""Generate the three example notebooks shipped under /examples.

Run with:
    python scripts/build_examples.py

The script writes deterministic .ipynb files via nbformat so the examples
can be rebuilt and reviewed without checking opaque JSON into the repo.
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
# 01 — clean & explore a tiny synthetic dataset (no model)
# ---------------------------------------------------------------------------


def example_explore() -> nbf.NotebookNode:
    return make_notebook(
        [
            md(
                "# Example 1 — Tiny exploration\n\n"
                "A short notebook that loads a small dataset, peeks at it, and "
                "draws one plot. Try **Initialize FlowQuest** in the banner — "
                "you'll get a baseline health, missions, and a quiz cell after "
                "the data-loading region."
            ),
            code(
                "import numpy as np\n"
                "import pandas as pd\n"
                "\n"
                "rng = np.random.default_rng(seed=7)"
            ),
            md("## Load some toy data"),
            code(
                "rows = 200\n"
                "df = pd.DataFrame({\n"
                "    'age': rng.integers(18, 70, size=rows),\n"
                "    'score': rng.normal(loc=50, scale=12, size=rows).round(1),\n"
                "    'group': rng.choice(['A', 'B', 'C'], size=rows),\n"
                "})\n"
                "df.head()"
            ),
            md(
                "## Look at the shape of the data\n"
                "Quick descriptive stats so we know what we're dealing with."
            ),
            code("df.describe()"),
            code("df['group'].value_counts()"),
            md("## One picture is worth a thousand `describe()` calls"),
            code(
                "import matplotlib.pyplot as plt\n"
                "\n"
                "fig, ax = plt.subplots(figsize=(6, 3))\n"
                "for label, sub in df.groupby('group'):\n"
                "    ax.hist(sub['score'], bins=15, alpha=0.6, label=label)\n"
                "ax.set_xlabel('score')\n"
                "ax.set_ylabel('count')\n"
                "ax.set_title('Score distribution by group')\n"
                "ax.legend()\n"
                "plt.show()"
            ),
            md(
                "## Reflect\n"
                "Click the FlowQuest chip on any cell and pick **Reflect** to earn "
                "Reader-Understanding points by answering one short question."
            ),
        ],
        description="Synthetic data, descriptive stats, single plot.",
    )


# ---------------------------------------------------------------------------
# 02 — clean → model → evaluate workflow
# ---------------------------------------------------------------------------


def example_model() -> nbf.NotebookNode:
    return make_notebook(
        [
            md(
                "# Example 2 — Tiny model\n\n"
                "Loads scikit-learn's iris dataset, trains a logistic regression, "
                "and evaluates it. This notebook covers all the regions FlowQuest "
                "knows about (`load`, `clean`, `explore`, `visualize`, `model`)."
            ),
            code(
                "from sklearn.datasets import load_iris\n"
                "from sklearn.linear_model import LogisticRegression\n"
                "from sklearn.model_selection import train_test_split\n"
                "from sklearn.metrics import accuracy_score, classification_report\n"
                "\n"
                "import pandas as pd"
            ),
            md("## Load"),
            code(
                "iris = load_iris(as_frame=True)\n"
                "df = iris.frame\n"
                "df.head()"
            ),
            md("## Light cleaning + split"),
            code(
                "X = df.drop(columns=['target'])\n"
                "y = df['target']\n"
                "\n"
                "X_train, X_test, y_train, y_test = train_test_split(\n"
                "    X, y, test_size=0.25, random_state=42, stratify=y\n"
                ")\n"
                "X_train.shape, X_test.shape"
            ),
            md("## Train a baseline"),
            code(
                "model = LogisticRegression(max_iter=500)\n"
                "model.fit(X_train, y_train)"
            ),
            md("## Evaluate honestly"),
            code(
                "pred = model.predict(X_test)\n"
                "print('accuracy:', round(accuracy_score(y_test, pred), 3))\n"
                "print(classification_report(y_test, pred, target_names=iris.target_names))"
            ),
            md(
                "## Try the difficulty selector\n"
                "Open the banner's `🧗 medium` pill and switch to **🔥 hard**. "
                "Generate a new quiz at the model checkpoint — the questions get "
                "more demanding and the LLM is stricter when re-grading."
            ),
        ],
        description="Iris classification with train/test split and metrics.",
    )


# ---------------------------------------------------------------------------
# 03 — intentionally messy notebook to give FlowQuest something to fix
# ---------------------------------------------------------------------------


def example_messy() -> nbf.NotebookNode:
    return make_notebook(
        [
            md(
                "# Example 3 — Messy on purpose\n\n"
                "This notebook has out-of-order execution, an unused variable, "
                "and a duplicated cell. Press **Initialize FlowQuest** and watch "
                "the missions populate. Each fix nudges Notebook Health closer "
                "to 100."
            ),
            # Pre-set execution counts so FlowQuest's analyzer sees the disorder
            # the moment the notebook is opened — without anyone running it.
            nbf.v4.new_code_cell(
                source="import pandas as pd\nimport numpy as np",
                execution_count=2,
            ),
            md("## Load"),
            nbf.v4.new_code_cell(
                source="df = pd.DataFrame({'x': [1, 2, 3, 4, 5], 'y': [10, 20, 30, 40, 50]})\ndf",
                execution_count=1,  # out of order on purpose
            ),
            md("## Clean (twice, oops)"),
            nbf.v4.new_code_cell(
                source="df = df.dropna()",
                execution_count=3,
            ),
            nbf.v4.new_code_cell(
                source="df = df.dropna()",  # duplicate
                execution_count=4,
            ),
            md("## Define an unused helper"),
            nbf.v4.new_code_cell(
                source="leftovers = df['x'].cumsum()  # never referenced again",
                execution_count=5,
            ),
            md("## Inspect"),
            nbf.v4.new_code_cell(
                source="df.describe()",
                execution_count=6,
            ),
        ],
        description="Notebook with on-purpose smell to exercise FlowQuest checks.",
    )


def main() -> None:
    write("01_explore", example_explore())
    write("02_model", example_model())
    write("03_messy_on_purpose", example_messy())


if __name__ == "__main__":
    main()
