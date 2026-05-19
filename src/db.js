const db = {
  users: [],
  messages: [],
};

module.exports = {
  getUsers: () => db.users,
  findUser: (query) => db.users.find(u => Object.entries(query).every(([k,v]) => u[k] === v)),
  addUser: (user) => { db.users.push(user); },
  updateUser: (id, data) => {
    const u = db.users.find(u => u.id === id);
    if (u) Object.assign(u, data);
  },
  getMessages: (userId1, userId2) => db.messages.filter(m =>
    (m.fromId === userId1 && m.toId === userId2) ||
    (m.fromId === userId2 && m.toId === userId1)
  ).sort((a, b) => a.createdAt > b.createdAt ? 1 : -1),
  addMessage: (msg) => { db.messages.push(msg); },
  markRead: (fromId, toId) => {
    db.messages.filter(m => m.fromId === fromId && m.toId === toId).forEach(m => { m.read = true; });
  },
};
