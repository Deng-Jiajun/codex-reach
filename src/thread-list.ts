import type { Project, Thread } from './types';

export type Grouping = 'date' | 'project' | 'status';
export function directoryKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function threadProject(thread: Thread, projects: Project[]): Project | undefined {
  const explicit = projects.find(project => project.id === thread.projectId);
  if (explicit) return explicit;
  const cwd = directoryKey(thread.cwd);
  return projects.find(project => directoryKey(project.path) === cwd);
}

export function threadTitle(thread: Pick<Thread, 'id' | 'title'>): string {
  const title = thread.title?.replace(/\s+/g, ' ').trim();
  if (!title || title === thread.id || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(title)) return '未命名对话';
  // Unnamed desktop threads may use the entire first message as their list title
  const characters = Array.from(title);
  return characters.length > 60 ? characters.slice(0, 60).join('') + '…' : title;
}

export function groupThreads(threads: Thread[], projects: Project[], grouping: Grouping): { title: string; threads: Thread[] }[] {
  const groups = new Map<string, { title: string; rank: string; threads: Thread[] }>();
  for (const thread of threads) {
    const project = threadProject(thread, projects);
    const projectPath = project ? directoryKey(project.path) : '';
    let title: string;
    let rank: string;
    if (thread.pinned) { title = '置顶'; rank = '0'; }
    else if (grouping === 'project') {
      title = project?.name || '无项目';
      rank = `1:${title}`;
    } else if (grouping === 'status') {
      if (['failed', 'systemError'].includes(thread.status)) { title = '异常'; rank = '1'; }
      else if (thread.waitingForUser) { title = '待处理'; rank = '1'; }
      else if (thread.waitingForThread) { title = '等待其他对话'; rank = '3'; }
      else if (['active', 'inProgress'].includes(thread.status)) { title = '进行中'; rank = '2'; }
      else { title = '其他对话'; rank = '4'; }
    } else {
      const date = new Date(thread.updatedAt * 1000);
      title = date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
      rank = `1:${String(9999999999 - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000).padStart(10, '0')}`;
    }
    const key = thread.pinned ? 'pinned' : grouping === 'project' ? `project:${projectPath}` : title;
    let group = groups.get(key);
    if (!group) { group = { title, rank, threads: [] }; groups.set(key, group); }
    group.threads.push(thread);
  }
  if (grouping === 'project') {
    const titles = [...groups.values()].map(group => group.title);
    for (const group of groups.values()) {
      if (group.rank !== '0' && titles.filter(title => title === group.title).length > 1) {
        const thread = group.threads[0];
        group.title += ` · ${threadProject(thread, projects)?.path || thread.cwd}`;
      }
    }
  }
  return [...groups.values()].sort((left, right) => left.rank.localeCompare(right.rank, 'zh-CN'))
    .map(group => ({ title: group.title, threads: group.threads.sort((left, right) => right.updatedAt - left.updatedAt) }));
}
