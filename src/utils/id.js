function createId(prefix = "id") {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = {
    createId
};
