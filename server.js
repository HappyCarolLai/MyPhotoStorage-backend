// photo-uploader-backend/server.js - 最終可運行版本

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const cors = require('cors'); // ✨ 【新增】載入 CORS 工具

const app = express();

// 🌐 解決跨域問題 (CORS) 設置
// 允許來自任何地方 (Access-Control-Allow-Origin: *) 的前端網頁來跟你的後端溝通
app.use(cors()); 

// 設定 Multer：將檔案存放在記憶體中，方便直接處理
const upload = multer({ storage: multer.memoryStorage() }); 

// 取得環境變數（Zeabur 會安全地提供這些值，請不要在這裡填寫實際的 Key）
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // 你的 GitHub 專屬鑰匙
const REPO_OWNER = process.env.REPO_OWNER;     // 你的 GitHub 帳號
const REPO_NAME = process.env.REPO_NAME;       // 你的倉庫名稱

// 檢查 Zeabur 是否有提供必要的環境變數
if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME) {
    console.error("❌ 錯誤：必要的環境變數 (GITHUB_TOKEN, REPO_OWNER, REPO_NAME) 缺失！請檢查 Zeabur 設定。");
    // 阻止伺服器啟動
    process.exit(1);
}


// 設定 API 接口：當有人對 /upload 發送 POST 請求時，執行以下程式
// 'photo' 參數必須和前端 <input type="file"> 傳送的 key 名稱一樣
app.post('/upload', upload.single('photo'), async (req, res) => {
    // 檢查有沒有檔案上傳
    if (!req.file) {
        return res.status(400).json({ error: '沒有收到照片檔案' });
    }
    
    // 取得照片檔案的內容 (Buffer)
    const fileBuffer = req.file.buffer;
    // 將檔案內容轉成 Base64 格式，這是 GitHub API 要求的格式
    const contentBase64 = fileBuffer.toString('base64');
    
    // 替照片取一個獨一無二的名字 (用時間戳記確保獨特性)
    const fileName = `${Date.now()}-${req.file.originalname.replace(/[^a-z0-9.]/gi, '_')}`; // 處理檔名特殊字元
    const filePath = `images/${fileName}`; // 檔案在 GitHub 倉庫中的路徑
    
    const githubApiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`;
    
    try {
        // 發送 HTTP 請求給 GitHub API 進行上傳 (PUT 請求)
        const response = await axios.put(githubApiUrl, {
            message: `feat: Add new photo ${fileName} via website uploader`,
            content: contentBase64,
        }, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`, // 帶上你的專屬鑰匙
                'Content-Type': 'application/json',
            },
        });
        
        // 成功上傳後的回應 (回傳 GitHub 的原始下載網址)
        const rawUrl = response.data.content.download_url;
        return res.json({ 
            status: 'success', 
            url: rawUrl, 
            message: '照片上傳成功！' 
        });

    } catch (error) {
        // 處理上傳失敗
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('上傳至 GitHub 失敗:', errorMessage);
        return res.status(500).json({ 
            status: 'error', 
            error: '無法上傳照片至 GitHub，請檢查 Token 權限或倉庫名稱。' 
        });
    }
});

// 設定伺服器要監聽的 Port，Zeabur 會指定一個 Port 給你
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`後端伺服器已在 Port ${PORT} 啟動`);
});