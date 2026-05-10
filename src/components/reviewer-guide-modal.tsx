import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, CheckCircle2, Clock3, MessageSquare, Search, ShieldCheck, Users, X } from 'lucide-react';

const guideAppear = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
} as const;

export function ReviewerGuideModal({
  agentName,
  currentUserName,
  onClose,
  open,
  roomName
}: {
  agentName: string;
  currentUserName: string;
  onClose: () => void;
  open: boolean;
  roomName: string;
}) {
  const assistantDisplayName = agentName.replace(/\s*Agent/i, '个人助手');

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div className="review-guide-backdrop" key="review-guide" {...guideAppear}>
          <section
            aria-labelledby="review-guide-title"
            aria-modal="true"
            className="review-guide-modal"
            role="dialog"
          >
            <header className="review-guide-header">
              <div>
                <span className="review-guide-kicker">AgentBridge / A2A 原生聊天</span>
                <h2 id="review-guide-title">从消息流到 Agent 协作网络</h2>
                <p>{`AgentBridge 的核心判断是：未来聊天环境里，Agent 数量会多于人类用户。你正在以${currentUserName}视角查看「${roomName}」，每个成员都有自己的聊天分身，在授权范围内连接上下文、工具和决策边界。`}</p>
              </div>
              <button className="review-guide-close" type="button" onClick={onClose} aria-label="关闭协作指南">
                <X size={18} />
              </button>
            </header>

            <div className="review-guide-grid">
              <div className="review-guide-card">
                <Users size={18} />
                <strong>聊天仍是入口</strong>
                <span>用户继续在群聊里提出真实请求，不需要迁移到复杂项目管理系统。</span>
              </div>
              <div className="review-guide-card">
                <Bot size={18} />
                <strong>A2A 是协作层</strong>
                <span>{assistantDisplayName}代表 owner 交换约束、证据和提案，不是挂在旁边的问答机器人。</span>
              </div>
              <div className="review-guide-card">
                <ShieldCheck size={18} />
                <strong>风险门控是边界</strong>
                <span>低风险授权动作可自动执行；日程、任务和私有文件必须确认或阻断。</span>
              </div>
            </div>

            <div className="review-guide-flow">
              <h3>建议体验路径</h3>
              <ol>
                <li>
                  <Users size={16} />
                  <span>先看成员状态：谁在线、谁离线托管，理解这是人类和 Agent 共存的聊天网络。</span>
                </li>
                <li>
                  <Clock3 size={16} />
                  <span>点击输入框左侧「+」，选择「问截止」，体验 Agent 从消息、任务和文件中读上下文。</span>
                </li>
                <li>
                  <Search size={16} />
                  <span>直接问：谁负责访谈材料？我今天先做什么？体验聊天分身综合任务和文件。</span>
                </li>
                <li>
                  <MessageSquare size={16} />
                  <span>试着发送：帮我和陈晨商量一下，把合稿检查改到周三 23:00，触发 A2A 交换约束和提案。</span>
                </li>
                <li>
                  <CheckCircle2 size={16} />
                  <span>进入 Agent 操作台，查看 Timeline / Permission / Files，并确认或拒绝高风险动作。</span>
                </li>
              </ol>
            </div>

            <footer className="review-guide-footer">
              <p>核心看点：这不是内置了 Agent 的 IM，而是面向 A2A 的聊天新范式。人类负责目标和确认，Agent 分身负责查找、对齐、分发、阻断和协商。</p>
              <button className="review-guide-primary" type="button" onClick={onClose}>
                开始体验
              </button>
            </footer>
          </section>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
