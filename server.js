// MyPhotoStorage-backend/server.js - 批次相簿管理核心 (MongoDB & GitHub 整合)

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors'); 
const mongoose = require('mongoose'); // MongoDB 連線工具

const app = express();
app.use(cors()); 
app.use(express.json()); // 讓 Express 可以解析 JSON 格式的請求

const upload = multer({ storage: multer.memoryStorage() }); 

// 取得環境變數
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const MONGODB_URL = process.env.MONGODB_URL; // MongoDB 連線字串

if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME || !MONGODB_URL) {
    console.error("❌ 錯誤：必要的環境變數缺失 (GitHub 或 MongoDB)");
    process.exit(1); 
}

// ----------------------------------------------------
// 1. MongoDB 連線與資料模型 (Schema) 定義
// ----------------------------------------------------

// 連線到 MongoDB
mongoose.connect(MONGODB_URL)
    .then(() => console.log('✅ MongoDB 連線成功'))
    .catch(err => console.error('❌ MongoDB 連線失敗:', err));

// 定義照片資料模型
const PhotoSchema = new mongoose.Schema({
    originalFileName: { type: String, required: true }, // 原始檔名 (中文)
    storageFileName: { type: String, required: true, unique: true }, // GitHub 上儲存的檔名 (包含時間戳)
    githubUrl: { type: String, required: true }, // GitHub 圖片下載網址 (CDN 用)
    albumId: { type: mongoose.Schema.Types.ObjectId, ref: 'Album' }, // 所屬相簿 ID
    uploadedAt: { type: Date, default: Date.now } // 上傳時間
});

// 定義相簿資料模型
const AlbumSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, unique: true }, // 相簿名稱
    coverUrl: { type: String, default: '' }, // 相簿封面圖片網址
    photoCount: { type: Number, default: 0 }, // 紀錄照片數量
    createdAt: { type: Date, default: Date.now } // 創建時間
});

const Photo = mongoose.model('Photo', PhotoSchema);
const Album = mongoose.model('Album', AlbumSchema);

// ----------------------------------------------------
// 2. API 路由 - 相簿管理 (Albums)
// ----------------------------------------------------

// [GET] 取得所有相簿列表
app.get('/api/albums', async (req, res) => {
    try {
        // 確保 '未分類相簿' 存在，如果不存在則創建
        let defaultAlbum = await Album.findOne({ name: '未分類相簿' });
        if (!defaultAlbum) {
            defaultAlbum = new Album({ name: '未分類相簿' });
            await defaultAlbum.save();
        }

        const albums = await Album.find().sort({ createdAt: -1 });
        res.json(albums);
    } catch (error) {
        console.error('取得相簿列表失敗:', error);
        res.status(500).json({ error: '無法取得相簿列表' });
    }
});

// [POST] 新增相簿
app.post('/api/albums', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) {
            return res.status(400).json({ error: '相簿名稱不能為空' });
        }
        
        // 檢查名稱是否重複
        const existingAlbum = await Album.findOne({ name });
        if (existingAlbum) {
             return res.status(409).json({ error: '相簿名稱已存在' });
        }
        
        const newAlbum = new Album({ name });
        await newAlbum.save();
        res.status(201).json(newAlbum);
    } catch (error) {
        console.error('新增相簿失敗:', error);
        res.status(500).json({ error: '無法新增相簿' });
    }
});

// [PUT] 修改相簿名稱或封面
app.put('/api/albums/:id', async (req, res) => {
    try {
        const { name, coverUrl } = req.body;
        if (!name) {
            return res.status(400).json({ error: '相簿名稱不能為空' });
        }
        
        // 避免重新命名為『未分類相簿』
        if (name === '未分類相簿') {
            return res.status(403).json({ error: '禁止將相簿名稱設定為「未分類相簿」' });
        }

        const album = await Album.findByIdAndUpdate(
            req.params.id, 
            { name: name, coverUrl: coverUrl }, 
            { new: true, runValidators: true } 
        );

        if (!album) {
            return res.status(404).json({ error: '找不到該相簿' });
        }

        res.json(album);
    } catch (error) {
        console.error('更新相簿失敗:', error);
        res.status(500).json({ error: '無法更新相簿' });
    }
});

// [DELETE] 刪除相簿 (將照片轉移到 '未分類相簿')
app.delete('/api/albums/:id', async (req, res) => {
    try {
        const albumId = req.params.id;
        
        const albumToDelete = await Album.findById(albumId);
        if (!albumToDelete) {
            return res.status(404).json({ error: '找不到該相簿' });
        }
        
        if (albumToDelete.name === '未分類相簿') {
            return res.status(403).json({ error: '禁止刪除預設的「未分類相簿」' });
        }

        let defaultAlbum = await Album.findOne({ name: '未分類相簿' });
        if (!defaultAlbum) {
            return res.status(500).json({ error: '系統錯誤：找不到預設相簿' });
        }

        // 1. 將該相簿下的所有照片轉移到 '未分類相簿'
        const updateResult = await Photo.updateMany(
            { albumId: albumId }, 
            { $set: { albumId: defaultAlbum._id } } 
        );
        
        // 2. 更新預設相簿的照片計數 (原子操作)
        if (updateResult.modifiedCount > 0) {
            await Album.findByIdAndUpdate(defaultAlbum._id, { $inc: { photoCount: updateResult.modifiedCount } });
        }

        // 3. 刪除相簿本身
        await Album.findByIdAndDelete(albumId);

        res.json({ 
            message: `相簿「${albumToDelete.name}」已刪除，其中 ${updateResult.modifiedCount} 張照片已移至「未分類相簿」。`
        });
        
    } catch (error) {
        console.error('刪除相簿失敗:', error);
        res.status(500).json({ error: '無法刪除相簿' });
    }
});

// ----------------------------------------------------
// 3. API 路由 - 照片管理 (Photos)
// ----------------------------------------------------

// [GET] 取得特定相簿裡的所有照片
app.get('/api/albums/:id/photos', async (req, res) => {
    try {
        const albumId = req.params.id;
        const photos = await Photo.find({ albumId: albumId }).sort({ uploadedAt: -1 });
        res.json(photos);
    } catch (error) {
        console.error('取得相簿照片失敗:', error);
        res.status(500).json({ error: '無法取得相簿照片' });
    }
});

// [PUT] 修改特定照片的名稱
app.put('/api/photos/:id', async (req, res) => {
    try {
        const { originalFileName } = req.body;
        if (!originalFileName) {
            return res.status(400).json({ error: '照片名稱不能為空' });
        }

        const photo = await Photo.findByIdAndUpdate(
            req.params.id, 
            { originalFileName: originalFileName }, 
            { new: true, runValidators: true }
        );

        if (!photo) {
            return res.status(404).json({ error: '找不到該照片' });
        }

        res.json(photo);
    } catch (error) {
        console.error('更新照片名稱失敗:', error);
        res.status(500).json({ error: '無法更新照片名稱' });
    }
});

// [PATCH] 移動特定照片到其他相簿 (相片移動)
app.patch('/api/photos/:id/move', async (req, res) => {
    try {
        const { targetAlbumId } = req.body;
        const photoId = req.params.id;

        if (!targetAlbumId) {
            return res.status(400).json({ error: '請提供目標相簿 ID' });
        }
        
        // 1. 檢查目標相簿是否存在
        const targetAlbum = await Album.findById(targetAlbumId);
        if (!targetAlbum) {
            return res.status(404).json({ error: '找不到目標相簿' });
        }
        
        // 2. 找到照片
        const photo = await Photo.findById(photoId);
        if (!photo) {
            return res.status(404).json({ error: '找不到該照片' });
        }
        
        const oldAlbumId = photo.albumId; // 舊的相簿 ID
        
        // 如果相簿相同，則不需移動
        if (oldAlbumId && oldAlbumId.toString() === targetAlbumId) {
            return res.status(200).json({ message: '照片已在目標相簿中', photo: photo });
        }

        // 3. 執行更新
        photo.albumId = targetAlbumId;
        await photo.save();

        // 4. 更新新舊相簿的照片計數 (原子操作)
        await Album.findByIdAndUpdate(oldAlbumId, { $inc: { photoCount: -1 } }); // 舊相簿減 1
        await Album.findByIdAndUpdate(targetAlbumId, { $inc: { photoCount: 1 } }); // 新相簿加 1

        res.json({ message: '照片已成功移動', photo: photo });

    } catch (error) {
        console.error('移動照片失敗:', error);
        res.status(500).json({ error: '無法移動照片' });
    }
});

// [DELETE] 刪除單張照片 (需同步刪除 GitHub 檔案)
app.delete('/api/photos/:id', async (req, res) => {
    try {
        const photo = await Photo.findById(req.params.id);
        if (!photo) {
            return res.status(404).json({ error: '找不到該照片' });
        }
        
        const filePath = `images/${photo.storageFileName}`;
        const githubApiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(filePath)}`;
        
        // 1. 取得檔案當前的 SHA
        const fileInfoResponse = await axios.get(githubApiUrl, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}` }
        });
        const sha = fileInfoResponse.data.sha;
        
        // 2. 從 GitHub 刪除檔案
        await axios.delete(githubApiUrl, {
            data: {
                message: `chore: Delete photo ${photo.originalFileName}`,
                sha: sha 
            },
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json',
            },
        });
        
        // 3. 從 MongoDB 刪除記錄
        await Photo.findByIdAndDelete(req.params.id);
        
        // 4. 更新相簿計數 (原子操作)
        if (photo.albumId) {
            await Album.findByIdAndUpdate(photo.albumId, { $inc: { photoCount: -1 } });
        }

        res.json({ message: '照片已成功刪除' });

    } catch (error) {
        const errorMessage = error.response ? error.response.data.message : error.message;
        console.error('刪除照片失敗:', errorMessage);
        res.status(500).json({ error: `無法刪除照片。錯誤訊息：${errorMessage}` });
    }
});


// ----------------------------------------------------
// 4. API 路由 - 檔案上傳 (Upload)
// ----------------------------------------------------

// 檔案上傳 API
app.post('/upload', upload.array('photos'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: '沒有收到照片檔案' });
    }

    // 預設將照片上傳到 '未分類相簿' (如果不存在則創建)
    let defaultAlbum = await Album.findOne({ name: '未分類相簿' });
    if (!defaultAlbum) {
        defaultAlbum = new Album({ name: '未分類相簿' });
        await defaultAlbum.save();
    }
    
    const results = [];
    let successCount = 0;
    
    for (const file of req.files) {
        // 中文檔名修復
        const originalnameFixed = Buffer.from(file.originalname, 'latin1').toString('utf8');
        
        const baseName = originalnameFixed.replace(/[^a-z0-9\u4e00-\u9fa5\.\-]/gi, '_');
        const rawFileName = `${Date.now()}-${baseName}`; 
        const filePath = `images/${rawFileName}`; 
        
        const githubApiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(filePath)}`;
        
        try {
            // 步驟 A: 上傳檔案到 GitHub
            await axios.put(githubApiUrl, {
                message: `feat: Batch upload photo ${originalnameFixed}`, 
                content: file.buffer.toString('base64'),
            }, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            });
            
            // GitHub Raw 圖片網址 (用於前端顯示)
            const githubDownloadUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${filePath}`;

            // 步驟 B: 將照片資訊寫入 MongoDB
            const newPhoto = new Photo({
                originalFileName: originalnameFixed,
                storageFileName: rawFileName,
                githubUrl: githubDownloadUrl,
                albumId: defaultAlbum._id 
            });
            await newPhoto.save();
            
            successCount += 1; // 增加成功計數
            results.push({
                status: 'success', 
                fileName: originalnameFixed, 
                url: githubDownloadUrl
            });

        } catch (error) {
            const errorMessage = error.response ? error.response.data.message : error.message;
            console.error(`上傳 ${originalnameFixed} 失敗:`, errorMessage);
            results.push({
                status: 'error', 
                fileName: originalnameFixed,
                error: `上傳失敗，請稍後重試或檢查檔案大小。`
            });
        }
    } 

    // 步驟 C: 批次上傳完成後，統一更新預設相簿的照片計數 (原子操作)
    if (successCount > 0) {
        await Album.findByIdAndUpdate(defaultAlbum._id, { $inc: { photoCount: successCount } });
    }

    return res.json({ 
        message: `批次上傳完成，總計 ${results.length} 個檔案。`,
        results: results
    });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`後端伺服器已在 Port ${PORT} 啟動`);
});