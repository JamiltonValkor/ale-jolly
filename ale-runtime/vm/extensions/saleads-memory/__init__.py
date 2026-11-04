"""Official Hermes registration; no built-in tools or provider are overridden."""
from .memory import MemoryPlugin
from .schemas import tools


def register(ctx):
    plugin = MemoryPlugin(ctx)
    schemas = tools()
    for name, handler, curator in (
        ('saleads_memory_recall', plugin.recall, False),
        ('saleads_curation_batch', plugin.batch, True),
        ('saleads_commit_candidates', plugin.commit, True),
    ):
        ctx.register_tool(name=name, toolset='saleads_memory', schema=schemas[name], handler=handler,
                          check_fn=lambda curator=curator: plugin.available(curator))
    ctx.register_tool(name='saleads_goal_update', toolset='saleads_memory', schema=schemas['saleads_goal_update'],
                      handler=plugin.goal, check_fn=lambda: plugin.role == 'ale' and plugin.available())
    ctx.register_hook('pre_llm_call', plugin.pre)
    ctx.register_hook('post_llm_call', plugin.post)
    ctx.register_hook('kanban_task_completed', plugin.native_terminal)
    ctx.register_hook('kanban_task_blocked', plugin.native_terminal)
