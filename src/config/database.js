let mongoose;

try {
    mongoose = require("mongoose");
} catch (_error) {
    mongoose = null;
}

async function connectDatabase() {
    const uri = process.env.MONGODB_URI;

    if (!mongoose || !uri) {
        console.warn("MongoDB disabled. Falling back to in-memory persistence.");
        return null;
    }

    try {
        await mongoose.connect(uri, {
            serverSelectionTimeoutMS: 3000
        });
        console.log("MongoDB connected");
        return mongoose.connection;
    } catch (error) {
        console.warn("MongoDB connection failed. Falling back to in-memory persistence.");
        console.warn(error.message);
        return null;
    }
}

function isMongoReady() {
    return Boolean(mongoose && mongoose.connection && mongoose.connection.readyState === 1);
}

module.exports = {
    connectDatabase,
    isMongoReady,
    mongoose
};
