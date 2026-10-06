# 自动视频制作 · dsh-auto-video

基于 Node.js 的自动视频制作流水线：千问负责素材分析、剧本、人物/场景设定、分镜与表演指令；阿里百炼执行图像、配音和视频生成；本地 FFmpeg 完成剪辑、音频床、字幕与终版合成。

## 核心流程

```text
素材与需求 → 导演脚本与人物/场景设定 → 配音计划
→ 配音与技术检查 → 自动语气审核 → 人工试听接受
→ 按实测时长规划分镜 → 首尾帧生成与检查
→ 视频生成、抽帧与相邻镜头检查 → 合成 → 播放验收
```

清单设置 `creative: true` 时进入精细创作链路；已有旧任务保留兼容路径。程序负责受控执行与结构校验，模型负责创作。运行链路不依赖外部助手回填，图片和视频仅走阿里百炼。

## 能力与验证边界

- 配音接受绑定实际音频、台词及表演要求；分镜依据实测时长生成。
- 语气审核区分模型结论、执行故障和人工决定；技术无效音频及过期绑定不可人工绕过。
- 修订按依赖使旧音频、分镜或媒体失效；支持受控返工、恢复和本地剪辑。
- 同输入复用已完成操作，未决提交不自动重发；每个制作单元首次生成后最多 3 次返工。
- 最终合成后等待用户播放验收，抽帧审核不等于完整画质、动作或口型通过。

最近有记录的完整离线测试：2026-10-03，280/280 通过。测试使用注入客户端、合成媒体与 FFmpeg，不等于真实 API 端到端验收。本次仓库筛选未重跑全量测试。

真实创作输出仍存在结构和内容问题；已制作的小样有 4.32 秒配音与两张首尾图，帧审核响应截断、视频未生成，不能宣称真实自动成片闭环已通过。

## 模型配置

| 用途 | 当前配置 |
| --- | --- |
| 规划、音频理解、语气审核 | qwen3.8-omni-flash |
| 图像质检 | qwen-vl-plus |
| 首尾帧 / 人物正脸 | qwen-image-3.0 / qwen-image-3.0-pro |
| 音色注册 / 配音 | qwen-voice-enrollment / qwen3-tts-vc-2026-01-22 |
| 音频驱动视频 / 动作视频 | wan2.7-i2v / wan2.2-kf2v-flash |

视频模型按镜头类型与时长选择。纯文本必须走规划适配器；`Models.json()` 仅做图像质检，无图请求会报 `PLANNER_REQUIRED_FOR_TEXT`。这些配置值不代表已重新核实供应商最新价格。

## 本地准备

需要支持 `node --test` 的 Node.js、npm，以及 FFmpeg / ffprobe。默认媒体工具路径为 `bin/ffmpeg.exe` 和 `bin/ffprobe.exe`，由 `config/project.json` 配置。

素材、凭证、输入清单及媒体工具需另外准备，不随仓库分发。程序正常从环境加载凭证，不在文档或日志保存密钥。

Windows PowerShell：

```powershell
npm.cmd ci
node index.js --help
node index.js init
```

`init` 只创建缺失输入模板，不覆盖已有文件；需填写真实故事、角色、参考图片和音频路径。

## 离线检查

```powershell
node index.js doctor input/production.json
node index.js status input/production.json
node scripts/check-repo.js
npm.cmd test
```

`doctor` 检查本地清单与素材；`status` 查看状态、轮次及费用；`check-repo` 检查源码语法与仓库约束；测试串行运行并可能产生临时夹具。没有 build 脚本，源码直接运行。

## 真实制作

默认 `config/aliyun.json` 中 `onlineEnabled=false`。真实调用需匹配制作 ID、供应商、区域及有效期的明确授权。授权文件由配置的 `authorizationFile` 指定，当前值指向既有第二片，新任务需配置自己的授权文件。

网页额度不等于 API 额度。目标 ¥50、硬上限 ¥70 仍存在于项目配置，但当前费用模块仅记录与预测，不按金额阻止执行；真实运行必须按当次约定控制费用。预留不是实扣，未知价格不当零，账单核实后登记结算。

以下命令仅在该任务获授权后执行，可能上传素材并计费：

```powershell
node index.js run input/production.json --until creative
node index.js run input/production.json --until audio
node index.js accept-creative-audio input/production.json ln01=audio/ln01.wav --method operator
node index.js run input/production.json --until storyboard
node index.js run input/production.json --until frames
node index.js run input/production.json --until video
node index.js run input/production.json --until final
```

用实际表演段 ID 和音频路径替换示例。有效阶段为 `characters|creative|script|audio|storyboard|frames|video|final`；不指定阶段时运行到 final，遇到验收或错误仍暂停。

语气审核未通过时普通接受被拒；用户复核后可用 `--tone-override "具体理由"` 保留原结论与人工决定。技术失败、无结论和输入失效不得以此放行。

## 修订与恢复

- `revise-creative`：按修订 JSON 校验并登记人物/场景、台词、配音或分镜等变更，不直接生成媒体。
- `redo`：准备 speech / frames / video 重做，不联网；首尾帧重做影响下游视频。
- `local-edit`：本地剪辑并重新导出，配音保持原速。
- `tone-review` / `audio-review`：模型音频审核，可能计费。
- `adopt-task` / `adopt-response` / `recover-script`：以供应商证据恢复原操作。
- `settle`：以整数分及账单证据登记实扣。

完整参数见 `node index.js --help`。设定变更后的分镜重规划目前为整体重规划。未决任务先核实供应商记录，不清空 submissionAttempted、不换 ID 重发、不删除预留或重置轮次。协议错误保留原响应并暂停，不能据此认定素材不合格。

## 目录

| 路径 | 内容 |
| --- | --- |
| index.js | 命令入口 |
| workflows/ | 制作、创作、审核、修订和恢复 |
| services/aliyun/ | 模型适配、任务状态、费用、额度、校验和媒体处理 |
| config/、examples/ | 配置与输入模板 |
| tests/、scripts/ | 离线测试与仓库检查 |
| docs/NEXT_SESSION.md | 仓库检查所需的简短制作约束 |

常规任务状态与审核页位于 `jobs/aliyun/<制作ID>/`；常规终版位于 `output/<制作ID>/final.mp4`，修订及专用小样以实际状态为准。

本仓库仅包含自动视频代码、配置、测试和必要说明。密钥、原始素材、Base64 请求、任务账本、输出、备份、工具二进制及临时文件保持本地。
