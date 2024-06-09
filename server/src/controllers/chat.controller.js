import mongoose from "mongoose";
import { User } from "../models/user.model.js";
import { Chat } from "../models/chat.model.js";
import { Message } from "../models/message.model.js";
import asyncHandler from "../utils/asyncHandler.js";
import apiResponse from "../utils/apiResponse.js";
import apiError from "../utils/apiError.js";
import { ChatEventEnum } from "../constants.js";
import { emitSocketEvent } from "../socket/index.js";
import { removeLocalFile } from "../utils/helpers.js";

const chatCommonAggregation = () => {
  return [
    {
      $lookup: {
        from: "users",
        foreignField: "_id",
        localField: "participants",
        as: "participants",
        pipeline: [
          {
            $project: {
              password: 0,
              refreshToken: 0,
            },
          },
        ],
      },
    },
    {
      $lookup: {
        from: "messages",
        foreignField: "_id",
        localField: "lastMessage",
        as: "lastMessage",
        pipeline: [
          {
            $lookup: {
              from: "users",
              foreignField: "_id",
              localField: "sender",
              as: "sender",
              pipeline: [
                {
                  $project: {
                    username: 1,
                    email: 1,
                    avatar: 1,
                  },
                },
              ],
            },
          },
          {
            $addFields: {
              sender: { $first: "$sender" },
            },
          },
        ],
      },
    },
    {
      $addFields: {
        lastMessage: { $first: "$lastMessage" },
      },
    },
  ];
};

// delete cascase messages

const deleteCascadeChatMessages = async (chatId) => {
  const messages = await Message.find({
    chat: new mongoose.Types.ObjectId(chatId),
  });

  let attachments = [];

  attachments = attachments.concat(
    ...messages.map((message) => {
      return message.attachments;
    })
  );

  attachments.forEach((attachment) => {
    removeLocalFile(attachment.localPath);
  });

  await Message.deleteMany({
    chat: new mongoose.Types.ObjectId(chatId),
  });
};

// search available users

const searchAvailableUsers = asyncHandler(async (req, res) => {
  const users = await User.aggregate([
    {
      $match: {
        _id: {
          $ne: req.user._id,
        },
      },
    },
    {
      $project: {
        username: 1,
        email: 1,
        avatar: 1,
      },
    },
  ]);

  if (!users) {
    throw new apiError(500, "Error in fetching users.");
  }

  return res
    .status(200)
    .json(new apiResponse(200, users, "Users fetched successfully."));
});

// create or access one-to-one chat

const createOrAccessOneToOneChat = asyncHandler(async (req, res) => {
  const { receiverId } = req.params;

  if (receiverId.toString() === req.user._id.toString()) {
    throw new apiError(400, "You cannot chat with yourself.");
  }

  const receiver = await User.findById(receiverId);

  if (!receiver) {
    throw new apiError(404, "Receiver not found.");
  }

  const chat = await Chat.aggregate([
    {
      $match: {
        isGroupChat: false,
        $and: [
          {
            participants: { $elemMatch: { $eq: req.user._id } },
          },
          {
            participants: {
              $elemMatch: { $eq: new mongoose.Types.Object(receiverId) },
            },
          },
        ],
      },
    },
    ...chatCommonAggregation(),
  ]);

  if (chat.length) {
    return res
      .status(200)
      .json(new apiResponse(200, chat[0], "Chat retrieved successfully."));
  }

  const newChatInstance = await Chat.create({
    name: "One-to-one Chat",
    participants: [req.user._id, new mongoose.Types.ObjectId(receiverId)],
    admin: req.user._id,
  });

  const createdChat = await Chat.aggregate([
    {
      $match: {
        _id: newChatInstance._id,
      },
    },
    ...chatCommonAggregation(),
  ]);

  const payload = createdChat[0];

  if (!payload) {
    throw new apiError(500, "Error in creating chat.");
  }

  payload?.participants?.forEach((participant) => {
    if (participant._id.toString() === req.user._id.toString()) return;

    emmitSocketEvent(
      req,
      participant._id?.toString(),
      ChatEventEnum.NEW_CHAT_EVENT,
      payload
    );
  });

  return res.status(201).json(201, payload, "Chat created successfully.");
});

// create group chat

const createGroupChat = asyncHandler(async (req, res) => {
  const { name, participants } = req.body;

  if (participants.includes(req.user._id.toString())) {
    throw new apiError(
      400,
      "You don't have to add yourself to the group chat."
    );
  }

  const members = [...new Set([...participants, req.user._id.toString()])];

  if (members.length < 3) {
    throw new apiError(400, "Group chat should have at least 3 members.");
  }

  const newGroupChat = await Chat.create({
    name,
    isGroupChat: true,
    participants: members,
    admin: req.user._id,
  });

  if (!newGroupChat) {
    throw new apiError(500, "Error in creating group chat.");
  }

  const chat = await Chat.aggregate([
    {
      $match: {
        _id: newGroupChat._id,
      },
    },
    ...chatCommonAggregation(),
  ]);

  if (!chat) {
    throw new apiError(500, "Error in fetching chat.");
  }

  const payload = chat[0];

  if (!payload) {
    throw new apiError(500, "Internal server error. Could not fetch chats.");
  }

  payload.participants?.forEach((participant) => {
    if (participant._id.toString() === req.user._id.toString()) return;

    emmitSocketEvent(
      req,
      participant._id?.toString(),
      ChatEventEnum.NEW_CHAT_EVENT,
      payload
    );
  });

  return res
    .status(201)
    .json(new apiResponse(201, payload, "Group chat created successfully."));
});

// get group chat details

const getGroupChatDetails = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const groupChat = await Chat.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(chatId),
        isGroupChat: true,
      },
    },
    ...chatCommonAggregation(),
  ]);

  const chat = groupChat[0];

  if (!chat) {
    throw new apiError(404, "Group chat not found.");
  }

  return res
    .status(200)
    .json(new apiResponse(200, chat, "Group chat retrieved successfully."));
});

// rename group chat

const renameGroupChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { name } = req.body;

  const groupChat = await Chat.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
    isGroupChat: true,
  });

  if (!groupChat) {
    throw new apiError(404, "Group chat not found.");
  }

  if (groupChat.admin?.toString() !== req.ser._id.toString()) {
    throw new apiError(
      403,
      "You are not authorized to rename this group chat."
    );
  }

  const updatedGroupChat = await Chat.findByIdAndUpdate(
    chatId,
    {
      $set: {
        name,
      },
    },
    {
      new: true,
    }
  );

  if (!updatedGroupChat) {
    throw new apiError(500, "Error in renaming group chat.");
  }

  const chat = await Chat.aggregate([
    {
      $match: {
        _id: updatedGroupChat._id,
      },
    },
    ...chatCommonAggregation(),
  ]);

  if (!chat) {
    throw new apiError(500, "Error in fetching updates group chat.");
  }

  const payload = chat[0];

  if (!payload) {
    throw new apiError(500, "Internal server error. Could not fetch chat.");
  }

  payload?.participants?.forEach((participant) => {
    emmitSocketEvent(
      req,
      participant._id?.toString(),
      ChatEventEnum.UPDATE_GROUP_NAME_EVENT,
      payload
    );
  });

  return res
    .status(200)
    .json(new apiResponse(200, payload, "Group chat renamed successfully."));
});

// delete group chat

const deleteGroupChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const groupChat = await Chat.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(chatId),
        isGroupChat: true,
      },
    },
    ...chatCommonAggregation(),
  ]);

  if (!groupChat) {
    throw new apiError(404, "Group chat not found.");
  }

  const chat = groupChat[0];

  if (!chat) {
    throw new apiError(500, "Error in fetching group chat.");
  }

  if (chat.admin?.toString() !== req.user._id?.toString()) {
    throw new apiError(
      403,
      "You are not authorized to delete this group chat."
    );
  }

  await Chat.findByIdAndDelete(chatId);

  await deleteCascadeChatMessages(chatId);

  chat?.participants?.forEach((participant) => {
    if (participant._id.toString() === req.user._id.toString()) return;

    emmitSocketEvent(
      req,
      participant._id?.toString(),
      ChatEventEnum.LEAVE_CHAT_EVENT,
      chat
    );
  });

  return res
    .status(200)
    .json(new apiResponse(200, {}, "Group chat deleted successfully."));
});

// delete one-to-one chat

const deleteOneToOneChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chat = await Chat.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(chatId),
      },
    },
    ...chatCommonAggregation(),
  ]);

  if (!chat) {
    throw new apiError(404, "Chat not found.");
  }

  const payload = chat[0];

  if (!payload) {
    throw new apiError(500, "Error in fetching chat.");
  }

  await Chat.findByIdAndDelete(chatId);

  await deleteCascadeChatMessages(chatId);

  const otherParticipant = payload?.participants.find(
    (participant) => participant?._id.toString() !== req.user._id.toString()
  );

  emmitSocketEvent(
    req,
    otherParticipant?._id?.toString(),
    ChatEventEnum.LEAVE_CHAT_EVENT,
    payload
  );

  return res
    .status(200)
    .json(new apiResponse(200, {}, "Chat deleted successfully."));
});

// leave group chat

const leaveGroupChat = aasyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const groupChat = await Chat.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
    isGroupChat: true,
  });

  if (!groupChat) {
    throw new apiError(404, "Group chat not found.");
  }

  const existingParticipants = groupChat.participants;

  if (!existingParticipants?.includes(req.user?._id)) {
    throw new apiError(400, "You are not part of this group chat.");
  }

  const updatedGroupChat = await Chat.findByIdAndUpdate(
    chatId,
    {
      $pull: {
        participants: req.user._id,
      },
    },
    {
      new: true,
    }
  );

  const chat = await Chat.aggregate([
    {
      $match: {
        _id: updatedGroupChat._id,
      },
    },
    ...chatCommonAggregation(),
  ]);

  const payload = chat[0];

  if (!payload) {
    throw new apiError(500, "Error in fetching chat.");
  }

  return res
    .status(200)
    .json(new apiResponse(200, payload, "Left group chat successfully."));
});

// add new participant in group chat

const addParticipantInGroupChat = asyncHandler(async (req, res) => {
  const { chatId, participantId } = req.params;

  const groupChat = await Chat.findOne([
    {
      _id: new mongoose.Types.ObjectId(chatId),
      isGroupChat: true,
    },
  ]);

  if (!groupChat) {
    throw new apiError(404, "Group chat not found.");
  }

  if (groupChat.admin?.toString() !== req.user._id.toString()) {
    throw new apiError(403, "You are not authorized to add participant.");
  }

  const existingParticipants = groupChat.participants;

  if (existingParticipants?.includes(participantId)) {
    throw new apiError(400, "Participant already exists in group chat.");
  }

  const updatedChat = await Chat.findByIdAndUpdate(
    chatId,
    {
      $push: {
        participants: participantId,
      },
    },
    {
      new: true,
    }
  );

  const chat = await Chat.aggregate([
    {
      $match: {
        _id: updatedChat._id,
      },
    },
    ...chatCommonAggregation(),
  ]);

  const payload = chat[0];

  if (!payload) {
    throw new apiError(500, "Error in fetching chat.");
  }

  emmitSocketEvent(req, participantId, ChatEventEnum.NEW_CHAT_EVENT, payload);

  return res
    .status(200)
    .json(new apiResponse(200, payload, "Participant added successfully."));
});

// remove participant(s) from group chat

const removeParticipantFromGroupChat = asyncHandler(async (req, res) => {
  const { chatId, participantId } = req.params;

  const groupChat = await Chat.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
    isGroupChat: true,
  });

  if (!groupChat) {
    throw new apiError(404, "Group chat does not exist");
  }

  if (groupChat.admin?.toString() !== req.user._id?.toString()) {
    throw new apiError(404, "You are not an admin");
  }

  const existingParticipants = groupChat.participants;

  if (!existingParticipants?.includes(participantId)) {
    throw new apiError(400, "Participant does not exist in the group chat");
  }

  const updatedChat = await Chat.findByIdAndUpdate(
    chatId,
    {
      $pull: {
        participants: participantId,
      },
    },
    { new: true }
  );

  const chat = await Chat.aggregate([
    {
      $match: {
        _id: updatedChat._id,
      },
    },
    ...chatCommonAggregation(),
  ]);

  const payload = chat[0];

  if (!payload) {
    throw new ApiError(500, "Internal server error");
  }

  emitSocketEvent(req, participantId, ChatEventEnum.LEAVE_CHAT_EVENT, payload);

  return res
    .status(200)
    .json(new apiResponse(200, payload, "Participant removed successfully"));
});

// get all chats

const getAllChats = asyncHandler(async (req, res) => {
  const chats = await Chat.aggregate([
    {
      $match: {
        participants: { $elemMatch: { $eq: req.user._id } },
      },
    },
    {
      $sort: {
        updatedAt: -1,
      },
    },
    ...chatCommonAggregation(),
  ]);

  return res
    .status(200)
    .json(
      new apiResponse(200, chats || [], "User chats fetched successfully!")
    );
});

export {
  searchAvailableUsers,
  createOrAccessOneToOneChat,
  createGroupChat,
  getGroupChatDetails,
  renameGroupChat,
  deleteGroupChat,
  deleteOneToOneChat,
  leaveGroupChat,
  addParticipantInGroupChat,
  removeParticipantFromGroupChat,
  getAllChats,
};
