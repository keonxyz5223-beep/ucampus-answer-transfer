# U校园 · 我的答案搬运助手

油猴脚本。只填写已经整理好的答案，不猜空着的题，也不自动解题。

当前版本 **0.4.3**。本版已内置教程3的 Unit 1–6 中已核对的 96 道练习。Unit 4 / Watching street interviews / Exercise 3 与 Unit 6 / Opening up / Exercise 2 为分组答案，缺真实题面，暂不收录。主窗口可以选择更新线路：

- 阿里云：https://dl.keon5223.xyz/ucampus-answer-transfer.user.js
- GitHub：https://raw.githubusercontent.com/keonxyz5223-beep/ucampus-answer-transfer/main/ucampus-answer-transfer.user.js

篡改猴自带的自动更新走阿里云。脚本里点「检查所选线路」时，按当时选中的那一条比较版本。

篡改猴打开上面的链接后安装。已装过的，在脚本主窗口点「检查更新」。发现新版本会打开安装页，点更新即可，不要选「重新安装」。更新不会清掉已导入的答案和本地提交记录。

匹配域名：`uai.unipus.cn`、`ucontent.unipus.cn`、`ucloud.unipus.cn`。

## 三个窗口

- 主窗口：选教材、单元和练习，看答案，手动填写或提交，导入 JSON。
- 定时答题窗口：设置分钟数和题数。运行时显示已用时、距本题提交还剩多少秒、当前单元和练习、完成题数。收起后顶部仍可停止。
- 操作日志窗口：简短中文实时记录；最近 120 条保存在本机，可点「导出」下载 UTF-8 文本，或点「清空」删除记录。可从主窗口关闭，关闭不会停止任务。0.4.2 及更早版本的旧日志只在原页面内存中，更新前先导出或截图。

三个窗口都能单独拖动。

## 导入答案

在主窗口「导入答案与页面工具」选择 JSON。导入只保存，不填写、不提交、不标绿。

把答案截图交给其他 AI 时，把仓库里的「给其他AI的转换提示词.txt」整段发给它。它只负责转成可导入 JSON，不改脚本，也不登录网站。

Unit 1 的答案文件是 `unit1-answers.json`。脚本内置教程 3 已核对的 Unit 1–6 练习。个人导入的答案仍优先于内置答案；此前导入过旧版第六单元 JSON 的，请再导入修正版 `unit6-answers.json` 覆盖错误记录。
