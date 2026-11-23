---
name: manual-acceptance
description: Single source of truth for manual user-side acceptance loops that cannot be replaced by unit tests. Load before final user-facing verification and select the relevant surface sibling.
---

# 手工验收入口

本技能维护无法完全由单元测试替代的用户侧实测验收闭环。不设打分表与质量点数；只关注用户实际操作后是否观察到预期结果，未达标即定位残余并指派负责人。

## 表面清单

- [web-tui.md](./web-tui.md)：官方 `omp` TUI + `host-omp-ui` Web 前端双端实时协同验收。

## 使用原则

- 每次验收只记录本次运行差异（环境、端口、观察结论、调整项）于 pin 或任务账本，不把单次日志写进本技能文件。
- 所有可自动化验证的契约交由单元测试与集成测试承担；本技能仅覆盖真实终端 TUI、真实浏览器渲染与双端并发交互体验。
