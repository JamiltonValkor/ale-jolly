import ast
from pathlib import Path

SOURCE = Path(__file__).parents[1] / "saleads_brain" / "server.py"


def test_managed_brain_tool_instructions_are_english_without_contract_renames() -> None:
    tree = ast.parse(SOURCE.read_text())
    tools = {
        node.name: ast.get_docstring(node) or ""
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef)
        and any(isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr == "tool"
                for d in node.decorator_list)
    }
    assert len(tools) == 21
    assert "Search" in tools["brain_query"]
    assert "owner_quote" in tools["brain_ingest"]
    assert "Only Ale" in tools["brain_record_learning"]
    assert "owner_quote" in tools["brain_record_feedback"]
    assert "Google News RSS" in tools["web_buscar"]  # legacy behavior stays documented, not enabled for Meta
    assert all("dueño" not in description for description in tools.values())
    instructions = next(
        node.value for node in tree.body
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "INSTRUCTIONS" for t in node.targets)
    )
    assert "Business memory" in ast.literal_eval(instructions)
