import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, CheckCircle2, Clock3, FileText, MessageSquare, Search, ShieldCheck, Users, X } from 'lucide-react';

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
                <span className="review-guide-kicker">团队协作空间</span>
                <h2 id="review-guide-title">协作空间指南</h2>
                <p>{`当前网站无需登录。你正在以${currentUserName}视角查看「${roomName}」。成员不在线时，个人助手会在授权范围内处理文件、日程和任务。`}</p>
              </div>
              <button className="review-guide-close" type="button" onClick={onClose} aria-label="关闭协作指南">
                <X size={18} />
              </button>
            </header>

            <div className="review-guide-grid">
              <div className="review-guide-card">
                <Users size={18} />
                <strong>成员状态</strong>
                <span>在线、忙碌、离线和托管状态会显示在会话列表、聊天顶部和成员面板里。</span>
              </div>
              <div className="review-guide-card">
                <Bot size={18} />
                <strong>个人助手</strong>
                <span>{assistantDisplayName}会在授权边界内帮助处理查询、文件、日程和协商。</span>
              </div>
              <div className="review-guide-card">
                <ShieldCheck size={18} />
                <strong>风险门控</strong>
                <span>低风险只读动作可以直接执行；文件代发、日程协调等动作会进入人工确认。</span>
              </div>
            </div>

            <div className="review-guide-flow">
              <h3>建议体验路径</h3>
              <ol>
                <li>
                  <Clock3 size={16} />
                  <span>点击输入框左侧「+」，选择「问截止」。</span>
                </li>
                <li>
                  <Search size={16} />
                  <span>继续选择「Agent 找文件」，用模糊线索匹配授权文件。</span>
                </li>
                <li>
                  <FileText size={16} />
                  <span>进入「Agent 操作台」，从「+」菜单选择「请求代发」。</span>
                </li>
                <li>
                  <MessageSquare size={16} />
                  <span>试着发送：帮我和陈晨商量一下，把合稿检查改到周三 23:00，触发个人助手协商。</span>
                </li>
                <li>
                  <CheckCircle2 size={16} />
                  <span>在右侧查看 Timeline / Permission / Files，并确认或拒绝高风险动作。</span>
                </li>
              </ol>
            </div>

            <footer className="review-guide-footer">
              <p>核心看点：成员不在线时，个人助手可以推进协作，但文件、日程和任务变更仍然可追踪、可接管。</p>
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
