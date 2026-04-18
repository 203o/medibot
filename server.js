require("dotenv").config({ override: true });

const app = require("./src/app");
const { connectDatabase } = require("./src/config/database");

const PORT = Number(process.env.PORT || 4000);

async function start() {
    await connectDatabase();

    app.listen(PORT, () => {
        console.log(`MediBot backend listening on http://localhost:${PORT}`);
    });
}

start().catch((error) => {
    console.error("Failed to start MediBot backend");
    console.error(error);
    process.exit(1);
});
