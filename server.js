// MyPhotoStorage-backend/server.js - 批次相簿管理核心 (MongoDB & GitHub 整合)

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors'); 
const mongoose = require('mongoose'); 

const app = express();
app.use(cors()); 
app.use(express.json()); 

const upload = multer({ storage: multer.memoryStorage() }); 

// 取得環境變數
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const MONGODB_URL = process.env.MONGODB_URL; 

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
    originalFileName: { type: String, required: true }, 
    storageFileName: { type: String, required: true, unique: true }, 
    githubUrl: { type: String, required: true }, 
    albumId: { type: mongoose.Schema.Types.ObjectId, ref: 'Album' }, 
    uploadedAt: { type: Date, default: Date.now } 
});

// 定義相簿資料模型
const AlbumSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, unique: true }, 
    coverUrl: { type: String, default: '' }, 
    photoCount: { type: Number, default: 0 }, 
    createdAt: { type: Date, default: Date.now } 
});

const Photo = mongoose.model('Photo', PhotoSchema);
const Album = mongoose.model('Album', AlbumSchema);

// ----------------------------------------------------
// 2. 輔助函式 (GitHub 相關)
// ----------------------------------------------------

/**
 * 從 GitHub 刪除單個檔案
 * @param {string} storageFileName - 儲存於 GitHub 的檔名 (含時間戳)
 * @returns {Promise<void>}
 */
async function deleteFileFromGitHub(storageFileName) {
    const filePath = `images/${storageFileName}`;
    const githubApiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(filePath)}`;
    
    // 1. 取得檔案當前的 SHA
    const fileInfoResponse = await axios.get(githubApiUrl, {
        headers: { 'Authorization': `token ${GITHUB_TOKEN}` }
    });
    const sha = fileInfoResponse.data.sha;
    
    // 2. 從 GitHub 刪除檔案
    await axios.delete(githubApiUrl, {
        data: {
            message: `chore: Delete photo ${storageFileName}`,
            sha: sha 
        },
        headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
        },
    });
}


// ----------------------------------------------------
// 3. API 路由 - 相簿管理 (Albums)
// ----------------------------------------------------

// ... (GET/POST/PUT/DELETE /api/albums 不變) ...
// [GET] 取得所有相簿列表
app.get('/api/albums', async (req, res) => {
    try {
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
        
        // 2. 更新預設相簿的照片計數
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
// 4. API 路由 - 照片管理 (Photos)
// ----------------------------------------------------

// [GET] 取得特定相簿裡的所有照片
app.get('/api/albums/:id/photos', async (req, res) => {
    try {
        const albumId = req.params.id;
        // 確保相簿存在
        if (!(await Album.findById(albumId))) {
             return res.status(404).json({ error: '找不到該相簿' });
        }
        const photos = await Photo.find({ albumId: albumId }).sort({ uploadedAt: -1 });
        res.json(photos);
    } catch (error) {
        console.error('取得相簿照片失敗:', error);
        res.status(500).json({ error: '無法取得相簿照片' });
    }
});

// [PUT] 修改特定照片的名稱 (此功能在前端新分頁中未實作，但保留後端 API)
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

// [PATCH] 移動特定照片到其他相簿 (單張照片移動)
app.patch('/api/photos/:id/move', async (req, res) => {
    try {
        const { targetAlbumId } = req.body;
        const photoId = req.params.id;

        if (!targetAlbumId) {
            return res.status(400).json({ error: '請提供目標相簿 ID' });
        }
        
        const targetAlbum = await Album.findById(targetAlbumId);
        if (!targetAlbum) {
            return res.status(404).json({ error: '找不到目標相簿' });
        }
        
        const photo = await Photo.findById(photoId);
        if (!photo) {
            return res.status(404).json({ error: '找不到該照片' });
        }
        
        const oldAlbumId = photo.albumId; 
        
        if (oldAlbumId && oldAlbumId.toString() === targetAlbumId) {
            return res.status(200).json({ message: '照片已在目標相簿中', photo: photo });
        }

        photo.albumId = targetAlbumId;
        await photo.save();

        // 更新新舊相簿的照片計數
        await Album.findByIdAndUpdate(oldAlbumId, { $inc: { photoCount: -1 } }); 
        await Album.findByIdAndUpdate(targetAlbumId, { $inc: { photoCount: 1 } }); 

        res.json({ message: '照片已成功移動', photo: photo });

    } catch (error) {
        console.error('移動照片失敗:', error);
        res.status(500).json({ error: '無法移動照片' });
    }
});

// [DELETE] 刪除單張照片
app.delete('/api/photos/:id', async (req, res) => {
    try {
        const photo = await Photo.findById(req.params.id);
        if (!photo) {
            return res.status(404).json({ error: '找不到該照片' });
        }
        
        // 1. 從 GitHub 刪除檔案
        await deleteFileFromGitHub(photo.storageFileName);
        
        // 2. 從 MongoDB 刪除記錄
        await Photo.findByIdAndDelete(req.params.id);
        
        // 3. 更新相簿計數
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
// 5. API 路由 - 批量照片操作 (新增部分，給前端 album-content.js 使用)
// ----------------------------------------------------

/**
 * [POST] 批量刪除照片 (DELETE /api/photos/bulkDelete)
 */
app.post('/api/photos/bulkDelete', async (req, res) => {
    const { photoIds } = req.body;
    if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0) {
        return res.status(400).json({ error: '請提供有效的照片 ID 列表進行批量刪除。' });
    }

    const successes = [];
    const failures = [];
    
    // 找出所有需要刪除的照片
    const photos = await Photo.find({ _id: { $in: photoIds } }).exec();
    
    // 處理所有刪除操作，使用 Promise.allSettled 確保單一失敗不會中斷整個批次
    const deletionPromises = photos.map(async (photo) => {
        try {
            // 1. 執行 GitHub 刪除
            await deleteFileFromGitHub(photo.storageFileName);

            // 2. 刪除資料庫紀錄
            await Photo.deleteOne({ _id: photo._id });
            
            // 3. 更新所屬相簿的照片數量
            if (photo.albumId) {
                // $inc: -1 是原子操作，可以安全地執行
                await Album.findByIdAndUpdate(photo.albumId, { $inc: { photoCount: -1 } });
            }

            successes.push(photo._id);
        } catch (error) {
            console.error(`刪除照片 ${photo._id} 失敗:`, error.message);
            failures.push({ 
                _id: photo._id, 
                error: error.message 
            });
        }
    });

    // 等待所有刪除操作完成
    await Promise.allSettled(deletionPromises);

    res.status(200).json({
        message: `批量刪除完成。成功刪除 ${successes.length} 張，失敗 ${failures.length} 張。`,
        successes,
        failures
    });
});


/**
 * [POST] 批量移動照片 (POST /api/photos/bulkMove)
 */
app.post('/api/photos/bulkMove', async (req, res) => {
    const { photoIds, targetAlbumId } = req.body;

    if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0 || !targetAlbumId) {
        return res.status(400).json({ error: '請提供有效的照片 ID 列表和目標相簿 ID。' });
    }

    // 檢查目標相簿是否存在
    const targetAlbum = await Album.findById(targetAlbumId);
    if (!targetAlbum) {
        return res.status(404).json({ error: '找不到目標相簿。' });
    }

    const successes = [];
    const failures = [];
    
    try {
        // 1. 找出所有待移動照片的舊相簿 ID (用於扣減舊相簿的計數)
        // 這裡需要確保 photoIds 都是有效的 ID
        const photos = await Photo.find({ _id: { $in: photoIds } }).select('albumId');
        if (photos.length === 0) {
            return res.status(404).json({ error: '找不到任何指定的照片。' });
        }
        
        // 2. 建立舊相簿計數變更地圖
        const oldAlbumUpdates = new Map();
        photos.forEach(photo => {
            const oldId = photo.albumId ? photo.albumId.toString() : 'null'; // 處理 albumId 為 null 的情況
            
            // 避免將照片從 A 移動到 A，導致重複更新計數
            if (oldId !== targetAlbumId.toString()) { 
                 oldAlbumUpdates.set(oldId, (oldAlbumUpdates.get(oldId) || 0) + 1);
            }
        });

        // 3. 在資料庫中執行批量更新操作 (將 albumId 設為新的 targetAlbumId)
        const updateResult = await Photo.updateMany(
            { _id: { $in: photoIds }, albumId: { $ne: targetAlbumId } }, // 排除已經在目標相簿中的照片
            { $set: { albumId: targetAlbumId } }
        );
        
        // 實際移動的照片數量 (成功寫入 DB 的數量)
        const actualMovedCount = updateResult.modifiedCount;

        if (updateResult.acknowledged) {
            // 4. 更新舊相簿的 photoCount (進行扣減)
            const decrementPromises = [];
            for (const [oldAlbumId, count] of oldAlbumUpdates.entries()) {
                if (oldAlbumId !== targetAlbumId.toString()) { // 再次確認，不從目標相簿中扣減
                     decrementPromises.push(
                        Album.findByIdAndUpdate(oldAlbumId, { $inc: { photoCount: -count } })
                    );
                }
            }
            await Promise.allSettled(decrementPromises);

            // 5. 更新新相簿的 photoCount (進行增加)
            if (actualMovedCount > 0) {
                 await Album.findByIdAndUpdate(targetAlbumId, { $inc: { photoCount: actualMovedCount } });
            }
            
            // 由於 updateMany 成功，所有 photoIds 都算成功
            photos.forEach(p => successes.push(p._id));
            
        } else {
            // 如果 updateMany 沒有確認成功，則視為失敗
            photoIds.forEach(id => failures.push({ _id: id, error: '資料庫更新失敗' }));
        }

    } catch (error) {
        console.error('批量移動照片失敗:', error);
        photoIds.forEach(id => failures.push({ _id: id, error: error.message }));
    }

    res.status(200).json({
        message: `批量移動完成。成功移動 ${successes.length} 張到「${targetAlbum.name}」。`,
        successes,
        failures
    });
});


// ----------------------------------------------------
// 6. API 路由 - 檔案上傳 (Upload) (不變)
// ----------------------------------------------------

// 檔案上傳 API
app.post('/upload', upload.array('photos'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: '沒有收到照片檔案' });
    }

    const { targetAlbumId } = req.body; 
    
    let defaultAlbum = await Album.findOne({ name: '未分類相簿' });
    if (!defaultAlbum) {
        defaultAlbum = new Album({ name: '未分類相簿' });
        await defaultAlbum.save();
    }
    
    let targetAlbum = defaultAlbum; 
    
    if (targetAlbumId) {
        const foundAlbum = await Album.findById(targetAlbumId);
        if (foundAlbum) {
            targetAlbum = foundAlbum; 
        }
    }
    
    const results = [];
    let successCount = 0;
    
    for (const file of req.files) {
        const originalnameFixed = Buffer.from(file.originalname, 'latin1').toString('utf8');
        
        const baseName = originalnameFixed.replace(/[^a-z0-9\u4e00-\u9fa5\.\-]/gi, '_');
        const rawFileName = `${Date.now()}-${baseName}`; 
        const filePath = `images/${rawFileName}`; 
        
        const githubApiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(filePath)}`;
        
        try {
            await axios.put(githubApiUrl, {
                message: `feat: Batch upload photo ${originalnameFixed}`, 
                content: file.buffer.toString('base64'),
            }, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            });
            
            const githubDownloadUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${filePath}`;

            const newPhoto = new Photo({
                originalFileName: originalnameFixed,
                storageFileName: rawFileName,
                githubUrl: githubDownloadUrl,
                albumId: targetAlbum._id 
            });
            await newPhoto.save();
            
            successCount += 1; 
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

    if (successCount > 0) {
        await Album.findByIdAndUpdate(targetAlbum._id, { $inc: { photoCount: successCount } });
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